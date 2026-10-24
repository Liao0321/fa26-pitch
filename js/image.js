// 上傳圖片前，在瀏覽器裡先縮小、壓縮成 JPEG，再轉成 base64 字串
// 最長邊約 800px，目標 150KB 以下；太大就自動降低品質、再縮小尺寸

const MAX_SIDE = 800;
const TARGET_BYTES = 150 * 1024;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("無法讀取這張圖片，請換成 JPG 或 PNG")); };
    img.src = url;
  });
}

// base64 字串大約是原始大小的 4/3
function dataUrlBytes(dataUrl) {
  return Math.round((dataUrl.length - dataUrl.indexOf(",") - 1) * 3 / 4);
}

export async function compressImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("請選擇圖片檔");
  const img = await loadImage(file);
  let scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  for (let round = 0; round < 6; round++) {
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.fillStyle = "#ffffff"; // 透明背景的 PNG 轉 JPEG 時填白色
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlBytes(dataUrl) <= TARGET_BYTES) {
        return { dataUrl, bytes: dataUrlBytes(dataUrl), width: canvas.width, height: canvas.height };
      }
    }
    scale *= 0.8; // 還是太大：尺寸再縮小 20%
  }
  throw new Error("圖片太複雜，壓縮後仍然太大，請換一張圖片");
}
