import { insert } from "./renderer";
type StyleMap = Record<string, Record<string, string | number>>;
export function makeStyles<T extends StyleMap>(stylesBySlots: T): () => Record<keyof T, string> {
  const compiled = stylesBySlots;
  return function useClasses(): Record<keyof T, string> {
    const out: Record<string, string> = {};
    for (const k in compiled) { insert(k); out[k] = k; }
    return out as Record<keyof T, string>;
  };
}
