import { useCallback, useRef, useState } from "react";
import type React from "react";
import { ImagePlus, X } from "lucide-react";

/** What the backend receives: base64 without the data: prefix. */
export interface ImagePayload {
  media_type: string;
  data: string;
}

export interface Attachment extends ImagePayload {
  id: string;
  url: string; // data URL for thumbnails
}

const MAX_IMAGES = 8;
const MAX_EDGE = 1568; // Claude's sweet spot; larger images are downscaled anyway
const PASSTHROUGH = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That file isn't an image TableView can read."));
    img.src = url;
  });
}

/** Reads a file as an attachment, downscaling big photos and converting odd formats (HEIC, TIFF…) to JPEG/PNG. */
async function toAttachment(file: Blob): Promise<Attachment> {
  const original = await readDataUrl(file);
  const img = await loadImage(original);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  let url = original;
  let type = file.type;
  if (scale < 1 || !PASSTHROUGH.includes(type) || file.size > 3_500_000) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    type = type === "image/png" || type === "image/gif" ? "image/png" : "image/jpeg";
    url = canvas.toDataURL(type, 0.88);
  }
  return { id: crypto.randomUUID(), url, media_type: type, data: url.slice(url.indexOf(",") + 1) };
}

function imageFiles(list: DataTransferItemList | FileList | null): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const it of Array.from(list as ArrayLike<DataTransferItem | File>)) {
    const f = it instanceof File ? it : it.kind === "file" ? it.getAsFile() : null;
    if (f && f.type.startsWith("image/")) out.push(f);
  }
  return out;
}

/** Image attachments for a compose box: paste, drop, or pick from disk. */
export function useAttachments(onError: (msg: string) => void) {
  const [images, setImages] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const add = useCallback(async (files: File[]) => {
    if (!files.length) return;
    try {
      const next = await Promise.all(files.map(toAttachment));
      setImages((cur) => {
        const all = [...cur, ...next];
        if (all.length > MAX_IMAGES) onError(`Attach at most ${MAX_IMAGES} images.`);
        return all.slice(0, MAX_IMAGES);
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }, [onError]);

  const remove = (id: string) => setImages((cur) => cur.filter((i) => i.id !== id));
  const clear = () => setImages([]);
  const payload = (): ImagePayload[] => images.map(({ media_type, data }) => ({ media_type, data }));

  /** Spread onto the element that should accept pastes and drops. */
  const zoneProps = {
    onPaste: (e: React.ClipboardEvent) => {
      const files = imageFiles(e.clipboardData.items);
      if (files.length) { e.preventDefault(); add(files); }
    },
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setDragging(true); }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      setDragging(false);
      const files = imageFiles(e.dataTransfer.files);
      if (files.length) { e.preventDefault(); add(files); }
    },
  };

  const picker = (
    <>
      <input ref={fileInput} type="file" accept="image/*" multiple hidden
        onChange={(e) => { add(imageFiles(e.target.files)); e.target.value = ""; }} />
      <button type="button" className="attach-btn" title="Attach images (or paste / drop them)" onClick={() => fileInput.current?.click()}>
        <ImagePlus size={15} />
      </button>
    </>
  );

  return { images, add, remove, clear, payload, dragging, zoneProps, picker };
}

export function AttachmentStrip({ images, onRemove }: { images: { id: string; url: string }[]; onRemove?: (id: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="attach-strip">
      {images.map((img) => (
        <div key={img.id} className="attach-thumb">
          <img src={img.url} alt="" draggable={false} />
          {onRemove && <button type="button" title="Remove" onClick={() => onRemove(img.id)}><X size={10} /></button>}
        </div>
      ))}
    </div>
  );
}
