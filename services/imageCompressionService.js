const sharp = require('sharp');
const path = require('path');

/**
 * Image Compression Service
 * 
 * Provides automated compression for image uploads (JPEG, PNG).
 * - Detects image vs non-image files safely via magic bytes / MIME / extensions.
 * - Preserves original aspect ratio and EXIF orientation.
 * - Retains full PNG transparency.
 * - Prevents dimension bloat while avoiding unnecessary downscaling.
 * - Never increases file size (if compressed is larger, retains original).
 * - Graceful fallback if compression fails.
 */

// Supported image MIME types and extensions
const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const SUPPORTED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);

// Reasonable max dimension for document/photo clarity (1920px Full HD preserves crisp text & detail)
const MAX_DIMENSION = 1920;

/**
 * Check if a file is an image based on declared MIME type and/or extension
 */
function isImageFile(mimeType, filenameOrExt) {
  const cleanMime = (mimeType || '').toLowerCase().trim();
  const ext = (path.extname(filenameOrExt || '') || filenameOrExt || '').toLowerCase().trim();

  if (SUPPORTED_IMAGE_MIMES.has(cleanMime)) return true;
  if (SUPPORTED_IMAGE_EXTS.has(ext)) return true;
  return false;
}

/**
 * Compress an image buffer (JPEG or PNG).
 * If the file is not an image (e.g. PDF), returns the original buffer unchanged.
 *
 * @param {Buffer} buffer - Binary file buffer
 * @param {string} mimeType - Declared or validated MIME type
 * @param {string} filename - Original filename (for extension check)
 * @param {Object} options - Custom compression options (optional)
 * @returns {Promise<{
 *   buffer: Buffer,
 *   mimeType: string,
 *   isImage: boolean,
 *   compressed: boolean,
 *   originalSize: number,
 *   compressedSize: number,
 *   savingsPercent: number,
 *   width?: number,
 *   height?: number,
 *   error?: string
 * }>}
 */
async function compressImageBuffer(buffer, mimeType, filename, options = {}) {
  const originalSize = buffer ? buffer.length : 0;

  if (!buffer || originalSize === 0) {
    return {
      buffer,
      mimeType,
      isImage: false,
      compressed: false,
      originalSize: 0,
      compressedSize: 0,
      savingsPercent: 0,
      error: 'Empty buffer provided'
    };
  }

  // If not an image (e.g. PDF), return original buffer untouched
  if (!isImageFile(mimeType, filename)) {
    return {
      buffer,
      mimeType,
      isImage: false,
      compressed: false,
      originalSize,
      compressedSize: originalSize,
      savingsPercent: 0
    };
  }

  try {
    const image = sharp(buffer, { failOnError: false });
    const metadata = await image.metadata();

    // Verify Sharp identified a valid format
    if (!metadata || !metadata.format) {
      return {
        buffer,
        mimeType,
        isImage: true,
        compressed: false,
        originalSize,
        compressedSize: originalSize,
        savingsPercent: 0,
        error: 'Unable to parse image metadata'
      };
    }

    const format = metadata.format.toLowerCase();
    const isJpeg = format === 'jpeg' || format === 'jpg';
    const isPng = format === 'png';

    if (!isJpeg && !isPng) {
      // Unsupported image format for compression, keep original
      return {
        buffer,
        mimeType,
        isImage: true,
        compressed: false,
        originalSize,
        compressedSize: originalSize,
        savingsPercent: 0
      };
    }

    // Auto-orient based on EXIF orientation to keep correct display direction
    let pipeline = image.rotate();

    // Resize only if image exceeds reasonable maximum dimension (prevents memory bloat while keeping 100% aspect ratio)
    const maxDim = options.maxDimension || MAX_DIMENSION;
    if (metadata.width && metadata.height && (metadata.width > maxDim || metadata.height > maxDim)) {
      pipeline = pipeline.resize({
        width: metadata.width > metadata.height ? maxDim : null,
        height: metadata.height >= metadata.width ? maxDim : null,
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    let outputMime = mimeType;
    if (isJpeg) {
      outputMime = 'image/jpeg';
      pipeline = pipeline.jpeg({
        quality: options.quality || 72,
        progressive: true,
        mozjpeg: true
      });
    } else if (isPng) {
      outputMime = 'image/png';
      // Preserve transparency & optimize PNG
      pipeline = pipeline.png({
        compressionLevel: options.compressionLevel || 9,
        adaptiveFiltering: true,
        palette: true,
        quality: options.quality || 80,
        effort: 8
      });
    }

    const compressedBuffer = await pipeline.toBuffer();
    const compressedSize = compressedBuffer.length;

    // Safety check: ensure compressed buffer is not empty or corrupted
    if (!compressedBuffer || compressedSize === 0) {
      console.warn('[COMPRESSION] Sharp generated 0-byte buffer; keeping original.');
      return {
        buffer,
        mimeType,
        isImage: true,
        compressed: false,
        originalSize,
        compressedSize: originalSize,
        savingsPercent: 0
      };
    }

    // Only adopt the compressed buffer if it actually reduced file size
    if (compressedSize < originalSize) {
      const savingsPercent = Math.round(((originalSize - compressedSize) / originalSize) * 100);
      console.log(
        `[COMPRESSION] Success: ${path.basename(filename || 'image')} ` +
        `compressed from ${(originalSize / 1024).toFixed(1)} KB to ${(compressedSize / 1024).toFixed(1)} KB ` +
        `(${savingsPercent}% reduction)`
      );
      return {
        buffer: compressedBuffer,
        mimeType: outputMime,
        isImage: true,
        compressed: true,
        originalSize,
        compressedSize,
        savingsPercent,
        width: metadata.width,
        height: metadata.height
      };
    } else {
      console.log(
        `[COMPRESSION] Original buffer is already smaller/optimal ` +
        `(${(originalSize / 1024).toFixed(1)} KB vs compressed ${(compressedSize / 1024).toFixed(1)} KB). Retaining original.`
      );
      return {
        buffer,
        mimeType,
        isImage: true,
        compressed: false,
        originalSize,
        compressedSize: originalSize,
        savingsPercent: 0,
        width: metadata.width,
        height: metadata.height
      };
    }
  } catch (err) {
    console.warn(`[COMPRESSION] Failed to compress image "${filename}": ${err.message}. Safely falling back to original.`);
    return {
      buffer,
      mimeType,
      isImage: true,
      compressed: false,
      originalSize,
      compressedSize: originalSize,
      savingsPercent: 0,
      error: err.message
    };
  }
}

/**
 * Compress a Base64 data URL string (e.g. from canvas or photo upload).
 *
 * @param {string} base64DataUrl - Data URL string (e.g. "data:image/jpeg;base64,...")
 * @param {Object} options - Custom compression options (optional)
 * @returns {Promise<{
 *   dataUrl: string,
 *   compressed: boolean,
 *   originalSize: number,
 *   compressedSize: number,
 *   savingsPercent: number
 * }>}
 */
async function compressBase64Image(base64DataUrl, options = {}) {
  if (!base64DataUrl || typeof base64DataUrl !== 'string' || !base64DataUrl.startsWith('data:image')) {
    return {
      dataUrl: base64DataUrl,
      compressed: false,
      originalSize: base64DataUrl ? base64DataUrl.length : 0,
      compressedSize: base64DataUrl ? base64DataUrl.length : 0,
      savingsPercent: 0
    };
  }

  try {
    const parts = base64DataUrl.split(',');
    if (parts.length !== 2) {
      return {
        dataUrl: base64DataUrl,
        compressed: false,
        originalSize: base64DataUrl.length,
        compressedSize: base64DataUrl.length,
        savingsPercent: 0
      };
    }

    const mimeMatch = parts[0].match(/:(image\/[a-zA-Z0-9+-]+);/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const inputBuffer = Buffer.from(parts[1], 'base64');

    // 1x1 student photo max dimension default is 600px (standard print-ready 300 DPI for 1x1 or 2x2 photo)
    const result = await compressImageBuffer(inputBuffer, mimeType, 'photo.jpg', {
      maxDimension: options.maxDimension || 600,
      quality: options.quality || 80,
      ...options
    });

    if (result.compressed && result.buffer) {
      const newBase64 = `data:${result.mimeType};base64,${result.buffer.toString('base64')}`;
      return {
        dataUrl: newBase64,
        compressed: true,
        originalSize: base64DataUrl.length,
        compressedSize: newBase64.length,
        savingsPercent: Math.round(((base64DataUrl.length - newBase64.length) / base64DataUrl.length) * 100)
      };
    }

    return {
      dataUrl: base64DataUrl,
      compressed: false,
      originalSize: base64DataUrl.length,
      compressedSize: base64DataUrl.length,
      savingsPercent: 0
    };
  } catch (err) {
    console.warn('[COMPRESSION] Failed to compress base64 image:', err.message);
    return {
      dataUrl: base64DataUrl,
      compressed: false,
      originalSize: base64DataUrl.length,
      compressedSize: base64DataUrl.length,
      savingsPercent: 0,
      error: err.message
    };
  }
}

module.exports = {
  isImageFile,
  compressImageBuffer,
  compressBase64Image
};
