import { Inner } from "./Inner";

// AiHub is an async entry root that concatenates `Inner` (its only importer).
// It does NOT import the constants directly — matching the real-world module
// whose concatenation clone re-activates an already-inlined const reference.
export function AiHub() {
  return Inner();
}
