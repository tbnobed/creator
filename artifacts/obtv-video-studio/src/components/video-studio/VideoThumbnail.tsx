import { useState } from "react";
import { Film } from "lucide-react";

/** previewUrl serves a JPEG; only mediaUrl may be used as a video source. */
export function VideoThumbnail({ previewUrl, mediaUrl, hoverPlay = false, active }: {
  previewUrl?: string | null;
  mediaUrl?: string | null;
  hoverPlay?: boolean;
  active?: boolean;
}) {
  const [failedPoster, setFailedPoster] = useState<string | null>(null);
  const [failedVideo, setFailedVideo] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const playing = hoverPlay && (active ?? hovering);
  const poster = previewUrl && failedPoster !== previewUrl ? previewUrl : null;
  const playable = mediaUrl && failedVideo !== mediaUrl;
  return <div className="relative flex size-full items-center justify-center"
    onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}>
    <Film aria-label="Video" className="size-6 text-muted-foreground" />
    {poster && !(playing && playable) ?
      <img src={poster} alt="" loading="lazy" className="absolute inset-0 size-full object-cover"
        onError={() => setFailedPoster(previewUrl!)} />
      : playable ? <video src={`${mediaUrl!.split("#")[0]}#t=0.1`} muted playsInline
        preload="metadata" autoPlay={playing} loop={hoverPlay}
        className="absolute inset-0 size-full object-cover"
        onError={() => setFailedVideo(mediaUrl!)} /> : null}
  </div>;
}