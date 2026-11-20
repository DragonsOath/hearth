import { useMemo } from "react";
import qrcode from "qrcode-generator";

/** A QR code drawn as SVG squares (dark on light, as phone cameras read best). */
export function QrCode({
  text,
  size = 220,
  label,
}: {
  text: string;
  size?: number;
  label: string;
}) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([c, r]);
    return { n, dark };
  }, [text]);
  const m = 4; // the quiet margin scanners need
  const span = cells.n + m * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${span} ${span}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-lg"
      data-testid="qr-code"
      data-text={text}
    >
      <rect width={span} height={span} fill="#ffffff" />
      <path fill="#000000" d={cells.dark.map(([x, y]) => `M${x + m} ${y + m}h1v1h-1z`).join("")} />
    </svg>
  );
}
