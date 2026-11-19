export type DbKind = "postgres" | "mysql" | "sqlite";
export type EnvTag = "local" | "dev" | "staging" | "prod";

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  database: string;
  file_path: string;
  ssl_mode: string;
  env: EnvTag | string;
  read_only: boolean;
  allow_claude: boolean;
}

export interface TableRef {
  schema: string;
  name: string;
  kind: "table" | "view" | string;
}

export interface SchemaTree {
  schemas: { name: string; tables: TableRef[] }[];
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  default: string | null;
  is_pk: boolean;
  is_fk: boolean;
  /** Where this column's foreign key points. */
  references?: ForeignRef;
}

export interface ForeignRef {
  schema: string;
  table: string;
  column: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

export interface ResultColumn {
  name: string;
  db_type: string;
}

export interface QueryResult {
  id: string;
  connection_id: string;
  sql: string;
  columns: ResultColumn[];
  row_count: number;
  elapsed_ms: number;
  truncated: boolean;
  rows_affected: number | null;
}

export interface Filter {
  column: string;
  op: string;
  value: string;
}

export interface BrowseOptions {
  limit: number;
  offset: number;
  filters: Filter[];
  order_by: { column: string; desc: boolean } | null;
}

export interface CellEdit {
  row: number;
  column: string;
  value: string | null;
}

export interface Changes {
  edits: CellEdit[];
  deletes: number[];
  inserts: Record<string, string | null>[];
}

export interface CommitOutcome {
  statements: string[];
  rows_affected: number;
}

export type VizKind = "bar" | "line" | "area" | "scatter" | "pie";

export interface VizSpec {
  kind: VizKind;
  x: string;
  y: string[];
  series_by?: string | null;
  title?: string | null;
}

export interface McpInfo {
  url: string;
  token: string;
  status: string;
  claude_command: string;
  claude_found: string | null;
}

export interface ChatSettings {
  side: "right" | "left";
  width: number;
  model: string;
  extra_instructions: string;
  claude_path: string;
}

export type Tab =
  | { id: string; kind: "table"; connectionId: string; table: TableRef; pinned?: boolean; filters?: Filter[] }
  | { id: string; kind: "query"; connectionId: string; title: string; sql: string; resultId?: string; fromClaude?: boolean; pinned?: boolean }
  | { id: string; kind: "chart"; connectionId: string; title: string; resultId: string; spec: VizSpec; pinned?: boolean };
