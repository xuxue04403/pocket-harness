/// Scroll positions that keep a streaming transcript usable.
///
/// Two rules matter and both are easy to get wrong:
///
/// * A reply that arrives while the reader is at the bottom should scroll with
///   it. A reply that arrives while the reader has scrolled up to read history
///   must not yank them back down — that makes reading impossible exactly when
///   there is the most to read.
/// * Loading older messages inserts rows above the viewport, so the scroll
///   offset that pointed at the top would now point into the middle of the new
///   batch. Keeping the distance from the bottom is what makes the content stay
///   put under the reader's thumb.
///
/// Kept as plain functions so the arithmetic is testable without a widget tree.
library;

/// How close to the bottom still counts as "following" the tail.
///
/// A phone's fling and bounce means the offset never sits exactly at the
/// maximum, and a viewport shorter than one message would otherwise never
/// qualify. About one message of slack is the right size to feel automatic
/// rather than stubborn.
const double tailSlack = 120;

/// Whether new content should scroll the view down to follow it.
bool followsTail(double offset, double maxScrollExtent, {double slack = tailSlack}) {
  // A freshly opened page has no extent yet; treating that as "at the bottom"
  // makes the first snapshot land scrolled down, which is what a reader wants.
  if (maxScrollExtent <= 0) return true;
  return maxScrollExtent - offset <= slack;
}

/// Offset that keeps the same slice of content under the reader's eyes after
/// [maxScrollExtent] grew from [previousExtent].
///
/// The reader's distance from the bottom is the anchor, because that end of the
/// list never changes when older rows are inserted above it.
double offsetHoldingDistance(double offset, double previousExtent, double nextExtent) {
  final distanceFromBottom = previousExtent - offset;
  final next = nextExtent - distanceFromBottom;
  if (next < 0) return 0;
  if (next > nextExtent) return nextExtent;
  return next;
}
