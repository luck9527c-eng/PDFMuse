export function prioritizedPageOrder(totalPages: number, currentPage: number) {
  if (!Number.isSafeInteger(totalPages) || totalPages <= 0) return [];
  const focus = Math.max(1, Math.min(totalPages, Math.floor(currentPage)));
  const pages = [focus];
  for (let offset = 1; pages.length < totalPages; offset += 1) {
    if (focus + offset <= totalPages) pages.push(focus + offset);
    if (focus - offset >= 1) pages.push(focus - offset);
  }
  return pages;
}
