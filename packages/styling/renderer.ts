const registry: Record<string, number> = {};
let counter = 0;
export function nextId(): number { return (counter += 1); }
// top-level side effect so this module is NOT side-effect-free
registry["__init__"] = nextId();
export function insert(key: string): number {
  registry[key] = nextId();
  return registry[key];
}
