import type { ParsedTrace } from "../shared/types";

export interface TraceLoader {
  canLoad(filePath: string, header?: Buffer): boolean;
  load(filePath: string): Promise<ParsedTrace>;
}
