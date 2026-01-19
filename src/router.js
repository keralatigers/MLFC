export function getRoute() {
  const hash = location.hash || "#/match";
  const [path, queryString] = hash.split("?");
  const query = new URLSearchParams(queryString || "");
  return { path, query };
}
