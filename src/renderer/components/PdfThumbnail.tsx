import { useEffect, useRef, useState } from "react";

export function PdfThumbnail({ page, current, load, onOpen }: { page: number; current: boolean; load(): Promise<string | undefined>; onOpen(): void }) {
  const itemRef = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<string>();
  useEffect(() => {
    const item = itemRef.current;
    if (!item || source) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void load().then(setSource);
    }, { rootMargin: "180px" });
    observer.observe(item);
    return () => observer.disconnect();
  }, [load, source]);
  useEffect(() => {
    if (current) itemRef.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <button ref={itemRef} className={`pdf-thumbnail ${current ? "current" : ""}`} aria-current={current ? "page" : undefined} onClick={onOpen}>
      <span className="thumbnail-page">{source ? <img src={source} alt={`第 ${page} 页缩略图`} /> : <span>正在载入</span>}</span>
      <strong>第 {page} 页</strong>
    </button>
  );
}
