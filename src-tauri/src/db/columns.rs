use std::sync::Arc;

use arrow_array::builder::{
    BooleanBuilder, Date32Builder, Float64Builder, Int64Builder, StringBuilder,
    TimestampMicrosecondBuilder,
};
use arrow_array::{Array, ArrayRef, RecordBatch, StringArray};
use arrow_schema::{DataType, Field, Schema, TimeUnit};
use chrono::{DateTime, NaiveDate};

/// One decoded value, independent of the driver it came from.
#[derive(Debug, Clone)]
pub enum Cell {
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    /// Microseconds since the Unix epoch. `tz` is true for zone-aware types.
    Ts {
        micros: i64,
        tz: bool,
    },
    /// Days since the Unix epoch.
    Date(i32),
    Str(String),
}

impl Cell {
    pub fn into_string(self) -> Option<String> {
        Val::from(self).into_string()
    }
}

/// A decoded value on its way into a column. `Text` borrows from the row, so
/// text columns are copied once, straight into the Arrow buffer.
#[derive(Debug)]
pub enum Val<'a> {
    Null,
    Int(i64),
    Float(f64),
    Bool(bool),
    Ts { micros: i64, tz: bool },
    Date(i32),
    Str(String),
    Text(&'a str),
}

impl From<Cell> for Val<'static> {
    fn from(c: Cell) -> Self {
        match c {
            Cell::Null => Val::Null,
            Cell::Int(v) => Val::Int(v),
            Cell::Float(v) => Val::Float(v),
            Cell::Bool(v) => Val::Bool(v),
            Cell::Ts { micros, tz } => Val::Ts { micros, tz },
            Cell::Date(d) => Val::Date(d),
            Cell::Str(s) => Val::Str(s),
        }
    }
}

impl Val<'_> {
    pub fn into_cell(self) -> Cell {
        match self {
            Val::Null => Cell::Null,
            Val::Int(v) => Cell::Int(v),
            Val::Float(v) => Cell::Float(v),
            Val::Bool(v) => Cell::Bool(v),
            Val::Ts { micros, tz } => Cell::Ts { micros, tz },
            Val::Date(d) => Cell::Date(d),
            Val::Str(s) => Cell::Str(s),
            Val::Text(s) => Cell::Str(s.to_string()),
        }
    }

    pub fn into_string(self) -> Option<String> {
        match self {
            Val::Null => None,
            Val::Int(v) => Some(v.to_string()),
            Val::Float(v) => Some(v.to_string()),
            Val::Bool(v) => Some(v.to_string()),
            Val::Ts { micros, tz } => Some(format_ts(micros, tz)),
            Val::Date(d) => Some(format_date(d)),
            Val::Str(s) => Some(s),
            Val::Text(s) => Some(s.to_string()),
        }
    }
}

pub fn format_ts(micros: i64, tz: bool) -> String {
    match DateTime::from_timestamp_micros(micros) {
        Some(dt) => {
            let base = dt.naive_utc().format("%Y-%m-%d %H:%M:%S%.6f").to_string();
            if tz { format!("{base}+00") } else { base }
        }
        None => micros.to_string(),
    }
}

pub fn format_date(days: i32) -> String {
    NaiveDate::from_num_days_from_ce_opt(days + 719_163)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_else(|| days.to_string())
}

/// Largest text a single column can hold: Arrow's Utf8 uses i32 offsets, and
/// overflowing them panics, which in a release build aborts the app.
const MAX_COLUMN_TEXT: usize = i32::MAX as usize - (1 << 20);

/// A column being filled row by row, straight into Arrow builders. It picks its
/// type from the first non-null value and widens (int to float, anything to
/// text) when a later value disagrees, which is what SQLite's per-value typing needs.
pub enum ColBuf {
    Empty(usize),
    Int(Int64Builder),
    Float(Float64Builder),
    Bool(BooleanBuilder),
    Ts(TimestampMicrosecondBuilder, bool),
    Date(Date32Builder),
    Str(StringBuilder),
}

fn push_text(b: &mut StringBuilder, s: &str) -> usize {
    if b.values_slice().len() + s.len() > MAX_COLUMN_TEXT {
        let note = format!(
            "<{} bytes: too large to load with the rest of this column>",
            s.len()
        );
        b.append_value(&note);
        return note.len() + 4;
    }
    b.append_value(s);
    s.len() + 4
}

impl ColBuf {
    pub fn new() -> Self {
        ColBuf::Empty(0)
    }

    /// Rewrites the column as text, for a value that does not fit its type.
    fn to_strings(&mut self) -> StringBuilder {
        fn conv<A: Array>(a: &A, f: impl Fn(usize) -> String) -> StringBuilder {
            let mut sb = StringBuilder::with_capacity(a.len() + 1, a.len() * 8);
            for i in 0..a.len() {
                if a.is_null(i) {
                    sb.append_null()
                } else {
                    sb.append_value(f(i))
                }
            }
            sb
        }
        match std::mem::replace(self, ColBuf::Empty(0)) {
            ColBuf::Empty(n) => {
                let mut sb = StringBuilder::new();
                sb.append_nulls(n);
                sb
            }
            ColBuf::Int(mut b) => {
                let a = b.finish();
                conv(&a, |i| a.value(i).to_string())
            }
            ColBuf::Float(mut b) => {
                let a = b.finish();
                conv(&a, |i| a.value(i).to_string())
            }
            ColBuf::Bool(mut b) => {
                let a = b.finish();
                conv(&a, |i| a.value(i).to_string())
            }
            ColBuf::Ts(mut b, tz) => {
                let a = b.finish();
                conv(&a, |i| format_ts(a.value(i), tz))
            }
            ColBuf::Date(mut b) => {
                let a = b.finish();
                conv(&a, |i| format_date(a.value(i)))
            }
            ColBuf::Str(b) => b,
        }
    }

    /// Appends one value and returns roughly how many bytes it adds to the Arrow data.
    #[cfg(test)]
    pub fn push(&mut self, val: impl Into<Val<'static>>) -> usize {
        self.push_val(val.into())
    }

    pub fn push_val(&mut self, val: Val<'_>) -> usize {
        if let ColBuf::Empty(n) = self {
            let n = *n;
            fn with_nulls<B: arrow_array::builder::ArrayBuilder>(
                mut b: B,
                n: usize,
                nulls: impl FnOnce(&mut B, usize),
            ) -> B {
                nulls(&mut b, n);
                b
            }
            *self = match &val {
                Val::Null => {
                    *self = ColBuf::Empty(n + 1);
                    return 1;
                }
                Val::Int(_) => {
                    ColBuf::Int(with_nulls(Int64Builder::new(), n, |b, n| b.append_nulls(n)))
                }
                Val::Float(_) => ColBuf::Float(with_nulls(Float64Builder::new(), n, |b, n| {
                    b.append_nulls(n)
                })),
                Val::Bool(_) => ColBuf::Bool(with_nulls(BooleanBuilder::new(), n, |b, n| {
                    b.append_nulls(n)
                })),
                Val::Ts { tz, .. } => ColBuf::Ts(
                    with_nulls(TimestampMicrosecondBuilder::new(), n, |b, n| {
                        b.append_nulls(n)
                    }),
                    *tz,
                ),
                Val::Date(_) => ColBuf::Date(with_nulls(Date32Builder::new(), n, |b, n| {
                    b.append_nulls(n)
                })),
                Val::Str(_) | Val::Text(_) => {
                    ColBuf::Str(with_nulls(StringBuilder::new(), n, |b, n| {
                        b.append_nulls(n)
                    }))
                }
            };
        }
        let rest = match (&mut *self, val) {
            (ColBuf::Int(b), Val::Null) => {
                b.append_null();
                return 1;
            }
            (ColBuf::Float(b), Val::Null) => {
                b.append_null();
                return 1;
            }
            (ColBuf::Bool(b), Val::Null) => {
                b.append_null();
                return 1;
            }
            (ColBuf::Ts(b, _), Val::Null) => {
                b.append_null();
                return 1;
            }
            (ColBuf::Date(b), Val::Null) => {
                b.append_null();
                return 1;
            }
            (ColBuf::Str(b), Val::Null) => {
                b.append_null();
                return 4;
            }
            (ColBuf::Int(b), Val::Int(x)) => {
                b.append_value(x);
                return 8;
            }
            (ColBuf::Float(b), Val::Float(x)) => {
                b.append_value(x);
                return 8;
            }
            (ColBuf::Float(b), Val::Int(x)) => {
                b.append_value(x as f64);
                return 8;
            }
            (ColBuf::Bool(b), Val::Bool(x)) => {
                b.append_value(x);
                return 1;
            }
            (ColBuf::Ts(b, a), Val::Ts { micros, tz }) if *a == tz => {
                b.append_value(micros);
                return 8;
            }
            (ColBuf::Date(b), Val::Date(x)) => {
                b.append_value(x);
                return 4;
            }
            (ColBuf::Str(b), Val::Text(s)) => return push_text(b, s),
            (ColBuf::Str(b), Val::Str(s)) => return push_text(b, &s),
            (ColBuf::Str(b), v) => return push_text(b, &v.into_string().unwrap_or_default()),
            (_, v) => v,
        };
        if let (ColBuf::Int(b), Val::Float(x)) = (&mut *self, &rest) {
            let a = b.finish();
            let mut f = Float64Builder::with_capacity(a.len() + 1);
            f.extend(a.iter().map(|o| o.map(|i| i as f64)));
            f.append_value(*x);
            *self = ColBuf::Float(f);
            return 8;
        }
        let mut sb = self.to_strings();
        let n = match rest.into_string() {
            Some(s) => push_text(&mut sb, &s),
            None => {
                sb.append_null();
                4
            }
        };
        *self = ColBuf::Str(sb);
        n
    }

    fn finish(self) -> (DataType, ArrayRef) {
        match self {
            ColBuf::Empty(n) => (DataType::Utf8, Arc::new(StringArray::new_null(n))),
            ColBuf::Int(mut b) => (DataType::Int64, Arc::new(b.finish())),
            ColBuf::Float(mut b) => (DataType::Float64, Arc::new(b.finish())),
            ColBuf::Bool(mut b) => (DataType::Boolean, Arc::new(b.finish())),
            ColBuf::Ts(mut b, tz) => {
                let zone: Option<Arc<str>> = if tz { Some("UTC".into()) } else { None };
                let arr = b.finish().with_timezone_opt(zone.clone());
                (
                    DataType::Timestamp(TimeUnit::Microsecond, zone),
                    Arc::new(arr),
                )
            }
            ColBuf::Date(mut b) => (DataType::Date32, Arc::new(b.finish())),
            ColBuf::Str(mut b) => (DataType::Utf8, Arc::new(b.finish())),
        }
    }
}

/// Collects decoded rows into Arrow, stopping at a row or byte cap. `bytes`
/// tracks the size of the Arrow data being built, so the byte cap bounds memory.
pub struct Collector {
    pub names: Vec<String>,
    pub db_types: Vec<String>,
    cols: Vec<ColBuf>,
    pub rows: usize,
    pub bytes: usize,
    max_rows: usize,
    max_bytes: usize,
}

impl Collector {
    pub fn new(max_rows: usize, max_bytes: usize) -> Self {
        Collector {
            names: vec![],
            db_types: vec![],
            cols: vec![],
            rows: 0,
            bytes: 0,
            max_rows,
            max_bytes,
        }
    }

    pub fn set_columns(&mut self, names: Vec<String>, db_types: Vec<String>) {
        self.cols = names.iter().map(|_| ColBuf::new()).collect();
        self.names = names;
        self.db_types = db_types;
        self.rows = 0;
        self.bytes = 0;
    }

    pub fn has_columns(&self) -> bool {
        !self.names.is_empty()
    }

    pub fn full(&self) -> bool {
        self.rows >= self.max_rows || self.bytes >= self.max_bytes
    }

    /// Adds one value of the current row; call `end_row` after the last column.
    pub fn push_val(&mut self, col: usize, v: Val<'_>) {
        if let Some(c) = self.cols.get_mut(col) {
            self.bytes += c.push_val(v);
        }
    }

    pub fn end_row(&mut self) {
        self.rows += 1;
    }

    #[cfg(test)]
    pub fn push_row(&mut self, cells: Vec<Cell>) {
        for (i, cell) in cells.into_iter().enumerate() {
            self.push_val(i, cell.into());
        }
        self.end_row();
    }

    pub fn to_ipc(self) -> anyhow::Result<Vec<u8>> {
        let mut fields = Vec::with_capacity(self.cols.len());
        let mut arrays = Vec::with_capacity(self.cols.len());
        let mut seen = std::collections::HashMap::<String, usize>::new();
        let ncols = self.cols.len();
        for (name, col) in self.names.iter().zip(self.cols) {
            let (dt, arr) = col.finish();
            let count = seen.entry(name.clone()).or_insert(0);
            let mut unique = if *count == 0 {
                name.clone()
            } else {
                format!("{name}_{count}")
            };
            *count += 1;
            // A suffixed name can itself collide with a real column ("a", "a", "a_1").
            while fields.iter().any(|f: &Field| f.name() == &unique) {
                unique.push('_');
            }
            fields.push(Field::new(unique, dt, true));
            arrays.push(arr);
        }
        let schema = Arc::new(Schema::new(fields));
        let batch = if arrays.is_empty() {
            RecordBatch::new_empty(schema.clone())
        } else {
            RecordBatch::try_new(schema.clone(), arrays)?
        };
        // Sized up front so the buffer is written once instead of regrown and copied.
        let mut buf = Vec::with_capacity(self.bytes + self.rows / 8 * ncols + 512 * ncols + 4096);
        {
            let mut w = arrow_ipc::writer::StreamWriter::try_new(&mut buf, &schema)?;
            w.write(&batch)?;
            w.finish()?;
        }
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widens_int_to_float_then_text() {
        let mut c = ColBuf::new();
        c.push(Cell::Null);
        c.push(Cell::Int(1));
        c.push(Cell::Float(2.5));
        assert!(matches!(c, ColBuf::Float(_)));
        c.push(Cell::Str("x".into()));
        match c {
            ColBuf::Str(mut b) => {
                let a = b.finish();
                let v: Vec<Option<&str>> = a.iter().collect();
                assert_eq!(v, vec![None, Some("1"), Some("2.5"), Some("x")]);
            }
            _ => panic!("expected text column"),
        }
    }

    #[test]
    fn duplicate_names_are_suffixed_and_ipc_roundtrips() {
        let mut col = Collector::new(10, 1 << 20);
        col.set_columns(
            vec!["a".into(), "a".into()],
            vec!["INT".into(), "INT".into()],
        );
        col.push_row(vec![Cell::Int(1), Cell::Null]);
        let bytes = col.to_ipc().unwrap();
        let reader =
            arrow_ipc::reader::StreamReader::try_new(std::io::Cursor::new(bytes), None).unwrap();
        let schema = reader.schema();
        assert_eq!(schema.field(0).name(), "a");
        assert_eq!(schema.field(1).name(), "a_1");
    }

    #[test]
    fn formats_timestamps_with_micros() {
        assert_eq!(
            format_ts(1_700_000_000_123_456, true),
            "2023-11-14 22:13:20.123456+00"
        );
        assert_eq!(format_date(0), "1970-01-01");
    }
}
