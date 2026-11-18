//! Row decoding for each driver. Every value becomes a `Cell`. Decoding goes
//! through sqlx's typed `Decode` impls, which accept both the binary format
//! (prepared statements) and the text format (`raw_sql`). Types with no
//! mapping fall back to their raw text, or to hex when the bytes are not UTF-8.

use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::mysql::{MySqlRow, MySqlValueRef};
use sqlx::postgres::types::{PgInterval, PgMoney, PgTimeTz};
use sqlx::postgres::{PgRow, PgTypeKind, PgValueFormat, PgValueRef};
use sqlx::sqlite::{SqliteRow, SqliteValueRef};
use sqlx::{Column, Decode, Row, TypeInfo, ValueRef};

use super::columns::{Cell, Collector, Val};

const EPOCH_DAYS_CE: i32 = 719_163;
const MAX_BLOB_HEX: usize = 2048;

fn days(d: NaiveDate) -> i32 {
    chrono::Datelike::num_days_from_ce(&d) - EPOCH_DAYS_CE
}

pub fn hex_bytes(b: &[u8]) -> String {
    let shown = &b[..b.len().min(MAX_BLOB_HEX)];
    let mut s = format!("\\x{}", hex::encode(shown));
    if b.len() > shown.len() {
        s.push_str(&format!("… ({} bytes)", b.len()));
    }
    s
}

fn text_or_hex(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s)
            if !s
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r') =>
        {
            s.to_string()
        }
        _ => hex_bytes(b),
    }
}

fn fmt_interval(i: &PgInterval) -> String {
    let mut parts = vec![];
    if i.months != 0 {
        let (y, m) = (i.months / 12, i.months % 12);
        if y != 0 {
            parts.push(format!("{y} year{}", if y.abs() == 1 { "" } else { "s" }));
        }
        if m != 0 {
            parts.push(format!("{m} mon{}", if m.abs() == 1 { "" } else { "s" }));
        }
    }
    if i.days != 0 {
        parts.push(format!(
            "{} day{}",
            i.days,
            if i.days.abs() == 1 { "" } else { "s" }
        ));
    }
    if i.microseconds != 0 || parts.is_empty() {
        let us = i.microseconds.abs();
        let sign = if i.microseconds < 0 { "-" } else { "" };
        let (h, m, s, f) = (
            us / 3_600_000_000,
            us / 60_000_000 % 60,
            us / 1_000_000 % 60,
            us % 1_000_000,
        );
        let frac = if f == 0 {
            String::new()
        } else {
            format!(".{f:06}").trim_end_matches('0').to_string()
        };
        parts.push(format!("{sign}{h:02}:{m:02}:{s:02}{frac}"));
    }
    parts.join(" ")
}

fn pg_dec<'r, T: Decode<'r, sqlx::Postgres>>(v: PgValueRef<'r>) -> Option<T> {
    T::decode(v).ok()
}

fn pg_array<'r, T>(v: PgValueRef<'r>, f: impl Fn(T) -> String) -> Option<String>
where
    Vec<Option<T>>: Decode<'r, sqlx::Postgres>,
{
    let items = <Vec<Option<T>> as Decode<sqlx::Postgres>>::decode(v).ok()?;
    let inner: Vec<String> = items
        .into_iter()
        .map(|x| match x {
            None => "NULL".to_string(),
            Some(x) => {
                let s = f(x);
                if s.is_empty() || s.contains([',', '{', '}', '"', ' ', '\\']) {
                    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
                } else {
                    s
                }
            }
        })
        .collect();
    Some(format!("{{{}}}", inner.join(",")))
}

/// Formats Postgres's binary NUMERIC exactly as `numeric_out` would, keeping
/// the column's scale (`numeric(10,2)` prints `1.25`, never `1.2500`).
pub fn pg_numeric_text(b: &[u8]) -> Option<String> {
    let rd = |i: usize| -> Option<u16> { Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?])) };
    let ndigits = rd(0)? as usize;
    let weight = rd(2)? as i16 as i32;
    let sign = rd(4)?;
    let dscale = rd(6)? as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => {}
    }
    let digits: Vec<u16> = (0..ndigits).map(|i| rd(8 + 2 * i)).collect::<Option<_>>()?;
    let digit = |i: i32| -> u16 {
        if i >= 0 && (i as usize) < digits.len() {
            digits[i as usize]
        } else {
            0
        }
    };
    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    if weight < 0 {
        out.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 {
                out.push_str(&digit(i).to_string());
            } else {
                out.push_str(&format!("{:04}", digit(i)));
            }
        }
    }
    if dscale > 0 {
        let mut frac = String::new();
        let mut i = weight + 1;
        while frac.len() < dscale {
            frac.push_str(&format!("{:04}", digit(i)));
            i += 1;
        }
        frac.truncate(dscale);
        out.push('.');
        out.push_str(&frac);
    }
    Some(out)
}

/// How a Postgres column is decoded, resolved once per result set from its type.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PgKind {
    Bool,
    I16,
    I32,
    I64,
    Oid,
    F32,
    F64,
    Numeric,
    Money,
    Uuid,
    Json,
    Jsonb,
    Date,
    Time,
    TimeTz,
    Ts,
    TsTz,
    Interval,
    Bytea,
    Inet,
    Cidr,
    Text,
    TextArr,
    I16Arr,
    I32Arr,
    I64Arr,
    F64Arr,
    BoolArr,
    UuidArr,
    NumericArr,
    /// Anything else: the server's text, or hex for binary bytes that are not text.
    Other,
}

pub fn pg_kind(info: &sqlx::postgres::PgTypeInfo) -> PgKind {
    let name = info.name();
    // Over the simple protocol sqlx leaves custom types (enums, domains,
    // extension types) unresolved; `kind()` panics on those, so use their text.
    if name == "?" || matches!(info.kind(), PgTypeKind::Enum(_)) {
        return PgKind::Other;
    }
    match name.to_ascii_uppercase().as_str() {
        "BOOL" => PgKind::Bool,
        "INT2" => PgKind::I16,
        "INT4" => PgKind::I32,
        "INT8" => PgKind::I64,
        "OID" => PgKind::Oid,
        "FLOAT4" => PgKind::F32,
        "FLOAT8" => PgKind::F64,
        "NUMERIC" => PgKind::Numeric,
        "MONEY" => PgKind::Money,
        "UUID" => PgKind::Uuid,
        "JSON" => PgKind::Json,
        "JSONB" => PgKind::Jsonb,
        "DATE" => PgKind::Date,
        "TIME" => PgKind::Time,
        "TIMETZ" => PgKind::TimeTz,
        "TIMESTAMP" => PgKind::Ts,
        "TIMESTAMPTZ" => PgKind::TsTz,
        "INTERVAL" => PgKind::Interval,
        "BYTEA" => PgKind::Bytea,
        "INET" => PgKind::Inet,
        "CIDR" => PgKind::Cidr,
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "XML" => PgKind::Text,
        "TEXT[]" | "VARCHAR[]" | "NAME[]" | "BPCHAR[]" => PgKind::TextArr,
        "INT2[]" => PgKind::I16Arr,
        "INT4[]" => PgKind::I32Arr,
        "INT8[]" => PgKind::I64Arr,
        "FLOAT8[]" => PgKind::F64Arr,
        "BOOL[]" => PgKind::BoolArr,
        "UUID[]" => PgKind::UuidArr,
        "NUMERIC[]" => PgKind::NumericArr,
        _ => PgKind::Other,
    }
}

/// Days from 0000-03-01-based civil calendar, valid for any day count (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    (y, m, d)
}

/// A Unix-epoch day count as Postgres prints it, BC years included.
fn pg_date_text(unix_days: i64) -> String {
    let (y, m, d) = civil_from_days(unix_days);
    if y <= 0 {
        format!("{:04}-{m:02}-{d:02} BC", 1 - y)
    } else {
        format!("{y:04}-{m:02}-{d:02}")
    }
}

const PG_EPOCH_DAYS: i64 = 10_957;
const PG_EPOCH_MICROS: i64 = 946_684_800_000_000;
/// Chrono and JavaScript both handle dates within about ±262,000 years.
const MAX_SAFE_DAYS: i64 = 95_000_000;

/// Binary DATE, decoded without sqlx's chrono impl, which panics (and so aborts
/// the app) on 'infinity' and on dates past chrono's range.
fn pg_date_bin(raw: i32) -> Val<'static> {
    match raw {
        i32::MAX => Val::Str("infinity".into()),
        i32::MIN => Val::Str("-infinity".into()),
        _ => {
            let unix = raw as i64 + PG_EPOCH_DAYS;
            if unix.abs() < MAX_SAFE_DAYS && unix > -719_162 {
                Val::Date(unix as i32)
            } else {
                Val::Str(pg_date_text(unix))
            }
        }
    }
}

/// Binary TIMESTAMP(TZ), same reasons as `pg_date_bin`.
fn pg_ts_bin(raw: i64, tz: bool) -> Val<'static> {
    match raw {
        i64::MAX => Val::Str("infinity".into()),
        i64::MIN => Val::Str("-infinity".into()),
        _ => match raw.checked_add(PG_EPOCH_MICROS) {
            Some(us)
                if us > -62_135_596_800_000_000
                    && DateTime::from_timestamp_micros(us).is_some() =>
            {
                Val::Ts { micros: us, tz }
            }
            _ => {
                let us = raw as i128 + PG_EPOCH_MICROS as i128;
                let (days, rem) = (us.div_euclid(86_400_000_000), us.rem_euclid(86_400_000_000));
                let date = pg_date_text(days as i64);
                let (h, m, sec, f) = (
                    rem / 3_600_000_000,
                    rem / 60_000_000 % 60,
                    rem / 1_000_000 % 60,
                    rem % 1_000_000,
                );
                let (day, bc) = date
                    .split_once(" BC")
                    .map(|(d, _)| (d.to_string(), " BC"))
                    .unwrap_or((date.clone(), ""));
                let frac = if f == 0 {
                    String::new()
                } else {
                    format!(".{f:06}").trim_end_matches('0').to_string()
                };
                Val::Str(format!(
                    "{day} {h:02}:{m:02}:{sec:02}{frac}{}{bc}",
                    if tz { "+00" } else { "" }
                ))
            }
        },
    }
}

fn pg_raw<'r, T: Decode<'r, sqlx::Postgres>>(v: &PgValueRef<'r>) -> Option<T> {
    if v.format() == PgValueFormat::Binary {
        T::decode(v.clone()).ok()
    } else {
        None
    }
}

pub fn pg_val<'r>(v: PgValueRef<'r>, kind: PgKind) -> Val<'r> {
    if v.is_null() {
        return Val::Null;
    }
    let text_fallback = |v: &PgValueRef<'r>| -> Val<'r> {
        match v.format() {
            PgValueFormat::Text => v.as_str().map(Val::Text).unwrap_or(Val::Null),
            PgValueFormat::Binary => match v.as_bytes() {
                Ok(b) => match std::str::from_utf8(b) {
                    Ok(s)
                        if !s
                            .chars()
                            .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r') =>
                    {
                        Val::Text(s)
                    }
                    _ => Val::Str(hex_bytes(b)),
                },
                Err(_) => Val::Null,
            },
        }
    };
    let decoded: Option<Val<'r>> = match kind {
        PgKind::Text | PgKind::Json | PgKind::Other => None,
        PgKind::Bool => pg_dec::<bool>(v.clone()).map(Val::Bool),
        PgKind::I16 => pg_dec::<i16>(v.clone()).map(|x| Val::Int(x as i64)),
        PgKind::I32 => pg_dec::<i32>(v.clone()).map(|x| Val::Int(x as i64)),
        PgKind::I64 => pg_dec::<i64>(v.clone()).map(Val::Int),
        PgKind::Oid => {
            pg_dec::<sqlx::postgres::types::Oid>(v.clone()).map(|x| Val::Int(x.0 as i64))
        }
        PgKind::F32 => {
            pg_dec::<f32>(v.clone()).map(|x| Val::Float(x.to_string().parse().unwrap_or(x as f64)))
        }
        PgKind::F64 => pg_dec::<f64>(v.clone()).map(Val::Float),
        PgKind::Numeric => match v.format() {
            PgValueFormat::Binary => v.as_bytes().ok().and_then(pg_numeric_text).map(Val::Str),
            PgValueFormat::Text => None,
        },
        PgKind::Money => {
            pg_dec::<PgMoney>(v.clone()).map(|m| Val::Str(m.to_bigdecimal(2).to_string()))
        }
        PgKind::Uuid => pg_dec::<uuid::Uuid>(v.clone()).map(|x| Val::Str(x.to_string())),
        // Keep the server's JSON text: key order and big numbers survive, so an edit
        // writes back exactly what was shown.
        PgKind::Jsonb => match v.format() {
            PgValueFormat::Text => None,
            PgValueFormat::Binary => v
                .as_bytes()
                .ok()
                .and_then(|b| b.split_first())
                .and_then(|(_, rest)| std::str::from_utf8(rest).ok())
                .map(Val::Text),
        },
        PgKind::Date => match pg_raw::<i32>(&v) {
            Some(raw) => Some(pg_date_bin(raw)),
            None => pg_dec::<NaiveDate>(v.clone()).map(|d| Val::Date(days(d))),
        },
        PgKind::Time => match pg_raw::<i64>(&v) {
            Some(86_400_000_000) => Some(Val::Str("24:00:00".into())),
            _ => pg_dec::<NaiveTime>(v.clone()).map(|t| Val::Str(t.to_string())),
        },
        PgKind::TimeTz => {
            pg_dec::<PgTimeTz>(v.clone()).map(|t| Val::Str(format!("{}{}", t.time, t.offset)))
        }
        PgKind::Ts => match pg_raw::<i64>(&v) {
            Some(raw) => Some(pg_ts_bin(raw, false)),
            None => pg_dec::<NaiveDateTime>(v.clone()).map(|t| Val::Ts {
                micros: t.and_utc().timestamp_micros(),
                tz: false,
            }),
        },
        PgKind::TsTz => match pg_raw::<i64>(&v) {
            Some(raw) => Some(pg_ts_bin(raw, true)),
            None => pg_dec::<DateTime<Utc>>(v.clone()).map(|t| Val::Ts {
                micros: t.timestamp_micros(),
                tz: true,
            }),
        },
        PgKind::Interval => pg_dec::<PgInterval>(v.clone()).map(|i| Val::Str(fmt_interval(&i))),
        PgKind::Bytea => match v.format() {
            PgValueFormat::Binary => v.as_bytes().ok().map(|b| Val::Str(hex_bytes(b))),
            PgValueFormat::Text => pg_dec::<Vec<u8>>(v.clone()).map(|b| Val::Str(hex_bytes(&b))),
        },
        PgKind::Inet => pg_dec::<ipnetwork::IpNetwork>(v.clone()).map(|x| {
            let host = x.prefix() == if x.is_ipv4() { 32 } else { 128 };
            Val::Str(if host {
                x.ip().to_string()
            } else {
                x.to_string()
            })
        }),
        PgKind::Cidr => pg_dec::<ipnetwork::IpNetwork>(v.clone()).map(|x| Val::Str(x.to_string())),
        PgKind::TextArr => pg_array::<String>(v.clone(), |s| s).map(Val::Str),
        PgKind::I16Arr => pg_array::<i16>(v.clone(), |x| x.to_string()).map(Val::Str),
        PgKind::I32Arr => pg_array::<i32>(v.clone(), |x| x.to_string()).map(Val::Str),
        PgKind::I64Arr => pg_array::<i64>(v.clone(), |x| x.to_string()).map(Val::Str),
        PgKind::F64Arr => pg_array::<f64>(v.clone(), |x| x.to_string()).map(Val::Str),
        PgKind::BoolArr => {
            pg_array::<bool>(v.clone(), |x| if x { "t".into() } else { "f".into() }).map(Val::Str)
        }
        PgKind::UuidArr => pg_array::<uuid::Uuid>(v.clone(), |x| x.to_string()).map(Val::Str),
        PgKind::NumericArr => pg_array::<BigDecimal>(v.clone(), |x| x.to_string()).map(Val::Str),
    };
    match decoded {
        Some(x) => x,
        None => text_fallback(&v),
    }
}

pub fn pg_cell(v: PgValueRef<'_>) -> Cell {
    let kind = pg_kind(&v.type_info());
    pg_val(v, kind).into_cell()
}

pub fn pg_row(row: &PgRow) -> Vec<Cell> {
    (0..row.columns().len())
        .map(|i| row.try_get_raw(i).map(pg_cell).unwrap_or(Cell::Null))
        .collect()
}

/// Decodes rows of one result set, with each column's decoder picked once.
pub struct PgDecoder(Vec<PgKind>);

impl PgDecoder {
    pub fn new(row: &PgRow) -> Self {
        PgDecoder(
            row.columns()
                .iter()
                .map(|c| pg_kind(c.type_info()))
                .collect(),
        )
    }

    pub fn push(&self, row: &PgRow, out: &mut Collector) {
        for (i, k) in self.0.iter().enumerate() {
            let v = row
                .try_get_raw(i)
                .map(|v| pg_val(v, *k))
                .unwrap_or(Val::Null);
            out.push_val(i, v);
        }
        out.end_row();
    }
}

fn my_dec<'r, T: Decode<'r, sqlx::MySql>>(v: MySqlValueRef<'r>) -> Option<T> {
    T::decode(v).ok()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MyKind {
    Int,
    UInt,
    BigUInt,
    Float,
    Double,
    Decimal,
    Date,
    DateTime,
    Timestamp,
    Time,
    Json,
    Bit,
    Bytes,
    Text,
    Other,
}

pub fn my_kind(name: &str) -> MyKind {
    match name.to_ascii_uppercase().as_str() {
        "BOOLEAN" | "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => MyKind::Int,
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "YEAR" => MyKind::UInt,
        "BIGINT UNSIGNED" => MyKind::BigUInt,
        "FLOAT" => MyKind::Float,
        "DOUBLE" => MyKind::Double,
        "DECIMAL" => MyKind::Decimal,
        "DATE" => MyKind::Date,
        "DATETIME" => MyKind::DateTime,
        "TIMESTAMP" => MyKind::Timestamp,
        "TIME" => MyKind::Time,
        "JSON" => MyKind::Json,
        "BIT" => MyKind::Bit,
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "GEOMETRY" => {
            MyKind::Bytes
        }
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            MyKind::Text
        }
        _ => MyKind::Other,
    }
}

/// MySQL dates that chrono cannot hold: zero dates (`0000-00-00`) and dates with
/// a zero month or day, which sqlx reports as NULL or fails to decode. They are
/// shown as MySQL prints them instead of as NULL.
fn my_odd_date<'r>(v: &MySqlValueRef<'r>, with_time: bool) -> Option<Val<'r>> {
    let b: &[u8] = <&[u8] as Decode<sqlx::MySql>>::decode(v.clone()).ok()?;
    match b.first()? {
        b'0'..=b'9' | b'-' => std::str::from_utf8(b).ok().map(Val::Text),
        &len => {
            let p = &b[1..];
            let byte = |i: usize| p.get(i).copied().unwrap_or(0) as u32;
            let (y, mo, d) = if len >= 4 {
                (byte(0) | byte(1) << 8, byte(2), byte(3))
            } else {
                (0, 0, 0)
            };
            let mut s = format!("{y:04}-{mo:02}-{d:02}");
            if with_time {
                s.push_str(&format!(" {:02}:{:02}:{:02}", byte(4), byte(5), byte(6)));
                if len >= 11 {
                    let us = byte(7) | byte(8) << 8 | byte(9) << 16 | byte(10) << 24;
                    s.push_str(&format!(".{us:06}"));
                }
            }
            Some(Val::Str(s))
        }
    }
}

pub fn mysql_val<'r>(v: MySqlValueRef<'r>, kind: MyKind) -> Val<'r> {
    let date_like = matches!(kind, MyKind::Date | MyKind::DateTime | MyKind::Timestamp);
    if v.is_null() {
        // sqlx reports zero dates as NULL; tell them apart from real NULLs.
        return if date_like {
            my_odd_date(&v, kind != MyKind::Date).unwrap_or(Val::Null)
        } else {
            Val::Null
        };
    }
    let decoded = match kind {
        MyKind::Int => my_dec::<i64>(v.clone()).map(Val::Int),
        MyKind::UInt => my_dec::<u64>(v.clone()).map(|x| Val::Int(x as i64)),
        MyKind::BigUInt => my_dec::<u64>(v.clone()).map(|x| {
            if x <= i64::MAX as u64 {
                Val::Int(x as i64)
            } else {
                Val::Str(x.to_string())
            }
        }),
        MyKind::Float => {
            my_dec::<f32>(v.clone()).map(|x| Val::Float(x.to_string().parse().unwrap_or(x as f64)))
        }
        MyKind::Double => my_dec::<f64>(v.clone()).map(Val::Float),
        MyKind::Decimal => my_dec::<BigDecimal>(v.clone()).map(|x| Val::Str(x.to_string())),
        MyKind::Date => my_dec::<NaiveDate>(v.clone())
            .map(|d| Val::Date(days(d)))
            .or_else(|| my_odd_date(&v, false)),
        MyKind::DateTime => my_dec::<NaiveDateTime>(v.clone())
            .map(|t| Val::Ts {
                micros: t.and_utc().timestamp_micros(),
                tz: false,
            })
            .or_else(|| my_odd_date(&v, true)),
        MyKind::Timestamp => my_dec::<DateTime<Utc>>(v.clone())
            .map(|t| Val::Ts {
                micros: t.timestamp_micros(),
                tz: true,
            })
            .or_else(|| my_odd_date(&v, true)),
        MyKind::Time => {
            my_dec::<sqlx::mysql::types::MySqlTime>(v.clone()).map(|t| Val::Str(t.to_string()))
        }
        MyKind::Json | MyKind::Text => my_dec::<&str>(v.clone()).map(Val::Text),
        MyKind::Bit => my_dec::<u64>(v.clone()).map(|x| Val::Str(format!("b'{x:b}'"))),
        MyKind::Bytes => my_dec::<&[u8]>(v.clone()).map(|b| match std::str::from_utf8(b) {
            Ok(s)
                if !s
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\r') =>
            {
                Val::Text(s)
            }
            _ => Val::Str(hex_bytes(b)),
        }),
        MyKind::Other => None,
    };
    decoded.unwrap_or_else(|| match my_dec::<&str>(v.clone()) {
        Some(s) => Val::Text(s),
        None => match my_dec::<&[u8]>(v.clone()) {
            Some(b) => Val::Str(text_or_hex(b)),
            None => Val::Str(format!("<{}>", v.type_info().name())),
        },
    })
}

pub fn mysql_cell(v: MySqlValueRef<'_>) -> Cell {
    let kind = my_kind(v.type_info().name());
    mysql_val(v, kind).into_cell()
}

pub fn mysql_row(row: &MySqlRow) -> Vec<Cell> {
    (0..row.columns().len())
        .map(|i| row.try_get_raw(i).map(mysql_cell).unwrap_or(Cell::Null))
        .collect()
}

pub struct MySqlDecoder(Vec<MyKind>);

impl MySqlDecoder {
    pub fn new(row: &MySqlRow) -> Self {
        MySqlDecoder(
            row.columns()
                .iter()
                .map(|c| my_kind(c.type_info().name()))
                .collect(),
        )
    }

    pub fn push(&self, row: &MySqlRow, out: &mut Collector) {
        for (i, k) in self.0.iter().enumerate() {
            let v = row
                .try_get_raw(i)
                .map(|v| mysql_val(v, *k))
                .unwrap_or(Val::Null);
            out.push_val(i, v);
        }
        out.end_row();
    }
}

pub fn sqlite_val(v: SqliteValueRef<'_>) -> Val<'_> {
    if v.is_null() {
        return Val::Null;
    }
    // SQLite types each value, not the column, so this is decided per value.
    let name = v.type_info().name().to_ascii_uppercase();
    match name.as_str() {
        "INTEGER" | "INT8" | "BOOLEAN" => <i64 as Decode<sqlx::Sqlite>>::decode(v)
            .map(Val::Int)
            .unwrap_or(Val::Null),
        "REAL" => <f64 as Decode<sqlx::Sqlite>>::decode(v)
            .map(Val::Float)
            .unwrap_or(Val::Null),
        "BLOB" => <&[u8] as Decode<sqlx::Sqlite>>::decode(v)
            .map(|b| Val::Str(text_or_hex(b)))
            .unwrap_or(Val::Null),
        // TEXT can hold invalid UTF-8; that shows as hex instead of failing.
        _ => match <&[u8] as Decode<sqlx::Sqlite>>::decode(v) {
            Ok(b) => match std::str::from_utf8(b) {
                Ok(s) => Val::Text(s),
                Err(_) => Val::Str(hex_bytes(b)),
            },
            Err(_) => Val::Null,
        },
    }
}

pub fn sqlite_cell(v: SqliteValueRef<'_>) -> Cell {
    sqlite_val(v).into_cell()
}

pub fn sqlite_row(row: &SqliteRow) -> Vec<Cell> {
    (0..row.columns().len())
        .map(|i| row.try_get_raw(i).map(sqlite_cell).unwrap_or(Cell::Null))
        .collect()
}

pub struct SqliteDecoder;

impl SqliteDecoder {
    pub fn new(_row: &SqliteRow) -> Self {
        SqliteDecoder
    }

    pub fn push(&self, row: &SqliteRow, out: &mut Collector) {
        for i in 0..row.columns().len() {
            let v = row.try_get_raw(i).map(sqlite_val).unwrap_or(Val::Null);
            out.push_val(i, v);
        }
        out.end_row();
    }
}

pub fn column_meta<R: Row>(row: &R) -> (Vec<String>, Vec<String>) {
    row.columns()
        .iter()
        .map(|c| (c.name().to_string(), c.type_info().name().to_string()))
        .unzip()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_formatting_matches_postgres_style() {
        let i = PgInterval {
            months: 14,
            days: 3,
            microseconds: 3_723_500_000,
        };
        assert_eq!(fmt_interval(&i), "1 year 2 mons 3 days 01:02:03.5");
        assert_eq!(
            fmt_interval(&PgInterval {
                months: 0,
                days: 0,
                microseconds: 0
            }),
            "00:00:00"
        );
    }

    #[test]
    fn numeric_binary_matches_postgres_text() {
        let enc = |ndigits: u16, weight: i16, sign: u16, dscale: u16, d: &[u16]| {
            let mut b = vec![];
            for x in [ndigits, weight as u16, sign, dscale] {
                b.extend_from_slice(&x.to_be_bytes());
            }
            for x in d {
                b.extend_from_slice(&x.to_be_bytes());
            }
            b
        };
        assert_eq!(
            pg_numeric_text(&enc(2, 0, 0, 2, &[1, 2500])).unwrap(),
            "1.25"
        );
        assert_eq!(pg_numeric_text(&enc(1, 0, 0, 2, &[45])).unwrap(), "45.00");
        assert_eq!(
            pg_numeric_text(&enc(2, 1, 0x4000, 0, &[12, 3456])).unwrap(),
            "-123456"
        );
        assert_eq!(
            pg_numeric_text(&enc(1, -1, 0, 6, &[5])).unwrap(),
            "0.000500"
        );
        assert_eq!(pg_numeric_text(&enc(0, 0, 0, 0, &[])).unwrap(), "0");
        assert_eq!(pg_numeric_text(&enc(0, 0, 0xC000, 0, &[])).unwrap(), "NaN");
    }

    #[test]
    fn hex_and_text_detection() {
        assert_eq!(text_or_hex(b"hello"), "hello");
        assert_eq!(text_or_hex(&[0xff, 0x00]), "\\xff00");
    }
}
