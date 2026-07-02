import { makeStyles } from "@repro/styling";
import { SEARCH_BOX_MAX_WIDTH, SIDE_PANE_WIDTH, HERO_MAX_WIDTH, STICKY_HEADER_PADDING, MODAL_MAX_WIDTH } from "../constants/stylingConstants";
export const useHomePageStyles = makeStyles({
  title: { maxWidth: SEARCH_BOX_MAX_WIDTH },
  pane: { width: SIDE_PANE_WIDTH },
  hero: { maxWidth: HERO_MAX_WIDTH, paddingTop: STICKY_HEADER_PADDING, minWidth: MODAL_MAX_WIDTH },
});
