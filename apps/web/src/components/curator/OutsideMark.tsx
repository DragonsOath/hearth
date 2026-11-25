/**
 * Ember thinking outside the box (the owner, 11-24): beside a pick that isn't squarely what you
 * asked for but shares its feel, when "Think outside the box" is on.
 */
export function OutsideMark() {
  return (
    <img
      src="/brand/ember-outside-box.webp"
      alt="Ember thinking outside the box"
      title="Ember thinking outside the box: not squarely what you asked, but close in feel"
      className="inline-block h-7 w-7 shrink-0 align-middle"
      data-testid="recommend-outside"
    />
  );
}
