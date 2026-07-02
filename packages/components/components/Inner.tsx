import { makeStyles } from "@repro/styling";
import { SEARCH_BOX_MAX_WIDTH, STICKY_HEADER_PADDING, MODAL_MAX_WIDTH, SIDE_PANE_WIDTH, HERO_MAX_WIDTH } from "../constants";

// The offending pattern: numeric consts consumed as arguments to a
// side-effects-free-by-package (`sideEffects:false`) `makeStyles` call.
// This attaches an (impure) deferred pure-check to each const's import,
// while inline-const still inlines the const to zero chunks.
const useInnerStyles = makeStyles({
  root: { maxWidth: SEARCH_BOX_MAX_WIDTH, paddingTop: STICKY_HEADER_PADDING },
  modal: { maxWidth: MODAL_MAX_WIDTH, width: SIDE_PANE_WIDTH },
  hero: { maxWidth: HERO_MAX_WIDTH },
});

export function Inner() {
  return useInnerStyles();
}
