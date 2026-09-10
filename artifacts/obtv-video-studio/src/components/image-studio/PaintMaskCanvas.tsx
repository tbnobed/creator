import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

interface PaintMaskCanvasProps {
  imageSrc: string;
  width: number;
  height: number;
  mode?: "edit" | "inpaint" | "outpaint";
  brushSize?: number;
  outpaintPadding?: number;
  onDirty?: () => void;
}

export interface PaintMaskCanvasRef {
  getMaskBlob: () => Promise<Blob | null>;
  getOutpaintBlobs: () => Promise<{
    expandedImage: Blob;
    mask: Blob;
    width: number;
    height: number;
  } | null>;
  clearMask: () => void;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export const PaintMaskCanvas = forwardRef<PaintMaskCanvasRef, PaintMaskCanvasProps>(
  (
    {
      imageSrc,
      width,
      height,
      mode = "edit",
      brushSize = 40,
      outpaintPadding = 256,
      onDirty,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef(false);
    const lastPointRef = useRef<{ x: number; y: number } | null>(null);
    const padding = mode === "outpaint" ? outpaintPadding : 0;
    const canvasWidth = width + padding * 2;
    const canvasHeight = height + padding * 2;
    const [displaySize, setDisplaySize] = useState({ width: canvasWidth, height: canvasHeight });

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      const resize = () => {
        const scale = Math.min(
          container.clientWidth / canvasWidth,
          container.clientHeight / canvasHeight,
        );
        setDisplaySize({
          width: Math.max(1, canvasWidth * scale),
          height: Math.max(1, canvasHeight * scale),
        });
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(container);
      return () => observer.disconnect();
    }, [canvasWidth, canvasHeight]);

    const resetMask = () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      context.globalCompositeOperation = "source-over";
      context.fillStyle = mode === "outpaint" ? "white" : "black";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (mode === "outpaint") {
        context.fillStyle = "black";
        context.fillRect(padding, padding, width, height);
      }
    };

    useEffect(() => {
      resetMask();
      drawingRef.current = false;
      lastPointRef.current = null;
    }, [imageSrc, width, height, mode, padding]);

    useImperativeHandle(ref, () => ({
      getMaskBlob: async () => {
        if (!canvasRef.current) return null;
        return canvasBlob(canvasRef.current);
      },
      getOutpaintBlobs: async () => {
        const maskCanvas = canvasRef.current;
        if (!maskCanvas || mode !== "outpaint") return null;

        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = canvasWidth;
        sourceCanvas.height = canvasHeight;
        const context = sourceCanvas.getContext("2d");
        if (!context) return null;

        const response = await fetch(imageSrc, { credentials: "include" });
        if (!response.ok) throw new Error("Could not load the source image for outpainting.");
        const sourceBlob = await response.blob();
        const bitmap = await createImageBitmap(sourceBlob);
        try {
          context.clearRect(0, 0, canvasWidth, canvasHeight);
          context.drawImage(bitmap, padding, padding, width, height);
        } finally {
          bitmap.close();
        }

        const [expandedImage, mask] = await Promise.all([
          canvasBlob(sourceCanvas),
          canvasBlob(maskCanvas),
        ]);
        if (!expandedImage || !mask) return null;
        return { expandedImage, mask, width: canvasWidth, height: canvasHeight };
      },
      clearMask: () => {
        resetMask();
        onDirty?.();
      },
    }), [imageSrc, width, height, mode, padding, canvasWidth, canvasHeight, onDirty]);

    const pointForEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    const drawTo = (point: { x: number; y: number }) => {
      const context = canvasRef.current?.getContext("2d");
      if (!context) return;
      const previous = lastPointRef.current ?? point;
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(point.x, point.y);
      context.lineWidth = brushSize;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.strokeStyle = "white";
      context.stroke();
      lastPointRef.current = point;
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (mode === "outpaint" || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drawingRef.current = true;
      const point = pointForEvent(event);
      if (point) drawTo(point);
      onDirty?.();
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current || mode === "outpaint") return;
      event.preventDefault();
      const point = pointForEvent(event);
      if (point) drawTo(point);
    };

    const handlePointerEnd = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      lastPointRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    };

    const sourceLeft = `${(padding / canvasWidth) * 100}%`;
    const sourceTop = `${(padding / canvasHeight) * 100}%`;
    const sourceWidth = `${(width / canvasWidth) * 100}%`;
    const sourceHeight = `${(height / canvasHeight) * 100}%`;

    return (
      <div ref={containerRef} className="flex h-full w-full touch-none items-center justify-center overflow-hidden">
        <div
          className="relative shrink-0 bg-white/10"
          style={{ width: displaySize.width, height: displaySize.height }}
        >
          <img
            src={imageSrc}
            alt="Source"
            draggable={false}
            className="pointer-events-none absolute object-fill"
            style={{
              left: sourceLeft,
              top: sourceTop,
              width: sourceWidth,
              height: sourceHeight,
            }}
          />
          <canvas
            ref={canvasRef}
            width={canvasWidth}
            height={canvasHeight}
            aria-label={mode === "outpaint" ? "Outpaint expansion mask" : "Paint edit mask"}
            className={`absolute inset-0 h-full w-full touch-none opacity-50 mix-blend-screen ${
              mode === "outpaint" ? "cursor-default" : "cursor-crosshair"
            }`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
          />
        </div>
      </div>
    );
  },
);

PaintMaskCanvas.displayName = "PaintMaskCanvas";