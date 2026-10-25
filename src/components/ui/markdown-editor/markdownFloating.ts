/** Anchor box of a floating editor panel, in viewport coordinates. */
export interface FloatingAnchorRect {
  left: number;
  top: number;
  bottom: number;
}

export type FloatingCloseReason = "outside" | "escape";
