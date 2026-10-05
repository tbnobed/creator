import { useState } from "react";
import { Film } from "lucide-react";

/** Keep a visible fallback underneath the video, including while a frame is decoded. */
export function GenerationThumbnail({ src }: { src: string }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    {(!ready || failed) && <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-secondary text-sm text-secondary-foreground" role="status">
      <Film className={failed ? "size-6" : "size-6 animate-pulse"} />
      {failed ? "Preview unavailable · Open to view" : "Loading preview…"}
    </div>}
    <video
      src={src}
      muted loop playsInline preload="auto"
      className={`absolute inset-0 size-full object-cover transition-opacity ${ready && !failed ? "opacity-100" : "opacity-0"}`}
      onLoadedData={() => setReady(true)}
      onError={() => setFailed(true)}
      onMouseEnter={event => { void event.currentTarget.play().catch(() => undefined); }}
      onMouseLeave={event => event.currentTarget.pause()}
    />
  </>;
}
