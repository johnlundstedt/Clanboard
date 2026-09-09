export default function Avatar({ user, size, className = "" }) {
  const initials = (user?.name || "?")
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  if (user?.photo_url) {
    return <img className={`avatar ${size} ${className}`.trim()} src={user.photo_url} alt={user.name} title={user.name} />;
  }
  return (
    <span className={`avatar ${size} ${className}`.trim()} title={user?.name}>
      {initials}
    </span>
  );
}