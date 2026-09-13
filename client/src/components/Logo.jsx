// Clanboard banner logo (PNG, ~2:1). Sized by height and scaled by width so the
// aspect ratio is preserved everywhere the logo is used.
export default function Logo({ size = 32, style, ...rest }) {
  return (
    <img
      src="/clan_board_logo.png"
      alt="Clanboard"
      draggable={false}
      style={{
        display: "inline-block",
        flex: "none",
        height: size,
        width: "auto",
        maxWidth: "100%",
        ...style,
      }}
      {...rest}
    />
  );
}