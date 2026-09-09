// Scalable Clanboard logo mark (SVG).
export default function Logo({ size = 32, style, ...rest }) {
  return (
    <img
      src="/clan_board_logo.svg"
      alt="Clanboard"
      width={size}
      height={size}
      draggable={false}
      style={{ display: "inline-block", flex: "none", ...style }}
      {...rest}
    />
  );
}