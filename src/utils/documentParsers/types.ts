export interface ParsedDocument {
  markdown: string;
  title: string;
  images: { data: Uint8Array; mime: string; page: number }[];
  tables: string[];
  warnings: string[];
}
