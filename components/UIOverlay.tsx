import React, { useState } from 'react';
import { TreeMode } from '../types';

interface UIOverlayProps {
  mode: TreeMode;
  onToggle: () => void;
  onPhotosUpload: (photos: string[]) => void;
  hasPhotos: boolean;
  uploadedPhotos: string[];
  isSharedView: boolean;
}

export const UIOverlay: React.FC<UIOverlayProps> = ({ mode, onToggle, onPhotosUpload, hasPhotos, uploadedPhotos, isSharedView }) => {
  const isFormed = mode === TreeMode.FORMED;
  const [isSharing, setIsSharing] = useState(false);
  const [shareLink, setShareLink] = useState<string>('');
  const [shareError, setShareError] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');

  // Helper function to convert base64 to Blob
  const base64ToBlob = (base64: string): Blob => {
    const byteString = atob(base64.split(',')[1]);
    const mimeString = base64.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
  };

  // Helper function to convert image URL to base64 for sharing
  const imageUrlToBase64 = async (url: string): Promise<string> => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      throw new Error(`Failed to load image: ${url}`);
    }
  };

  const handleShare = async () => {
    if (!uploadedPhotos || uploadedPhotos.length === 0) {
      setShareError('没有照片可分享');
      return;
    }

    setIsSharing(true);
    setShareError('');
    setShareLink('');
    setUploadProgress('准备分享...');

    try {
      // Convert image URLs to base64 for sharing
      setUploadProgress('加载照片中...');
      const base64Photos = await Promise.all(
        uploadedPhotos.map(url => imageUrlToBase64(url))
      );

      // Use localStorage fallback for sharing
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname.includes('127.0.0.1');
      
      if (isLocalDev) {
        try {
          const shareId = Math.random().toString(36).substring(2, 10);
          const shareData = {
            images: base64Photos,
            createdAt: Date.now(),
          };
          localStorage.setItem(`share_${shareId}`, JSON.stringify(shareData));
          const shareLink = `${window.location.origin}/?share=${shareId}`;
          setShareLink(shareLink);
          return;
        } catch (storageError: any) {
          setShareError('图片数据太大，请减少照片数量或大小');
          return;
        }
      }

      // Try API first (for production)
      setUploadProgress('获取上传地址...');
      const urlsResponse = await fetch('/api/get-upload-urls', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          imageCount: uploadedPhotos.length,
        }),
      });

      // If API returns 404, use localStorage fallback
      if (urlsResponse.status === 404) {
        try {
          const shareId = Math.random().toString(36).substring(2, 10);
          const shareData = {
            images: base64Photos,
            createdAt: Date.now(),
          };
          localStorage.setItem(`share_${shareId}`, JSON.stringify(shareData));
          const shareLink = `${window.location.origin}/?share=${shareId}`;
          setShareLink(shareLink);
          return;
        } catch (storageError: any) {
          setShareError('图片数据太大，请减少照片数量或大小');
          return;
        }
      }

      const urlsData = await urlsResponse.json();

      if (!urlsResponse.ok) {
        throw new Error(urlsData.error || '获取上传地址失败');
      }

      const { shareId, uploadUrls } = urlsData;

      // Step 2: Upload images directly to R2 using presigned URLs
      setUploadProgress(`上传照片中 (0/${base64Photos.length})...`);
      
      let uploadedCount = 0;
      const uploadPromises = base64Photos.map(async (photo, index) => {
        const blob = base64ToBlob(photo);
        const { uploadUrl, publicUrl } = uploadUrls[index];

        const uploadResponse = await fetch(uploadUrl, {
          method: 'PUT',
          body: blob,
          headers: {
            'Content-Type': 'image/jpeg',
          },
        });

        if (!uploadResponse.ok) {
          throw new Error(`上传第 ${index + 1} 张图片失败`);
        }

        uploadedCount++;
        setUploadProgress(`上传照片中 (${uploadedCount}/${base64Photos.length})...`);
        return publicUrl;
      });

      const imageUrls = await Promise.all(uploadPromises);

      // Step 3: Complete the upload by storing metadata in KV
      setUploadProgress('生成分享链接...');
      const completeResponse = await fetch('/api/complete-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          shareId,
          imageUrls,
        }),
      });

      const completeData = await completeResponse.json();

      if (!completeResponse.ok) {
        throw new Error(completeData.error || '保存分享信息失败');
      }

      setShareLink(completeData.shareLink);
    } catch (error: any) {
      console.error('Share error:', error);
      
      // Fallback to localStorage for network errors
      const isLocalDev = window.location.hostname === 'localhost' || window.location.hostname.includes('127.0.0.1');
      
      if (isLocalDev && (error.message?.includes('Failed to fetch') || error.name === 'TypeError')) {
        try {
          console.log('Network error, using localStorage fallback');
          // Convert to base64 if not already
          const base64Photos = await Promise.all(
            uploadedPhotos.map(url => {
              if (url.startsWith('data:')) return url;
              return imageUrlToBase64(url);
            })
          );
          const shareId = Math.random().toString(36).substring(2, 10);
          const shareData = {
            images: base64Photos,
            createdAt: Date.now(),
          };
          localStorage.setItem(`share_${shareId}`, JSON.stringify(shareData));
          const shareLink = `${window.location.origin}/?share=${shareId}`;
          setShareLink(shareLink);
          return;
        } catch (storageError: any) {
          setShareError('图片数据太大，请减少照片数量或大小');
          return;
        }
      }
      
      setShareError(error.message || '分享失败，请重试');
    } finally {
      setIsSharing(false);
      setUploadProgress('');
    }
  };

  const handleCopyLink = async () => {
    if (!shareLink) return;

    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Copy failed:', error);
    }
  };

  const handleCreateMine = () => {
    // 清除 URL 参数，刷新页面
    window.location.href = window.location.origin;
  };

  return (
    <div className="absolute top-0 left-0 w-full h-full pointer-events-none z-10">
      
      {/* Header */}
      <header className="absolute top-8 left-1/2 transform -translate-x-1/2 flex flex-col items-center">
        <h1 className="text-4xl md:text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-[#D4AF37] via-[#F5E6BF] to-[#D4AF37] font-serif drop-shadow-lg tracking-wider text-center">
          Merry Christmas
        </h1>
      </header>

      {/* Right Bottom Action Area */}
      <div className="absolute bottom-8 right-8 flex flex-col items-end gap-4 pointer-events-auto">
        
        {/* Shared View: Show "制作我的圣诞树" button */}
        {isSharedView && (
          <button
            onClick={handleCreateMine}
            className="group px-6 py-3 border-2 border-[#D4AF37] bg-black/70 backdrop-blur-md overflow-hidden transition-all duration-500 hover:shadow-[0_0_30px_#D4AF37] hover:border-[#fff] hover:bg-[#D4AF37]/20"
          >
            <span className="relative z-10 font-serif text-base md:text-lg text-[#D4AF37] tracking-[0.1em] group-hover:text-white transition-colors whitespace-nowrap">
              制作我的圣诞树
            </span>
          </button>
        )}

        {/* Not Shared View: Show share controls */}
        {!isSharedView && (
          <>
            {/* Share Button - Show when photos are available but link not generated */}
            {hasPhotos && !shareLink && (
              <div className="flex flex-col items-end gap-2">
                <button
                  onClick={handleShare}
                  disabled={isSharing}
                  className="group px-6 py-3 border-2 border-[#D4AF37] bg-black/70 backdrop-blur-md overflow-hidden transition-all duration-500 hover:shadow-[0_0_30px_#D4AF37] hover:border-[#fff] hover:bg-[#D4AF37]/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="relative z-10 font-serif text-base md:text-lg text-[#D4AF37] tracking-[0.1em] group-hover:text-white transition-colors whitespace-nowrap">
                    {uploadProgress || (isSharing ? '生成中...' : '生成分享链接')}
                  </span>
                </button>
                {shareError && (
                  <p className="text-red-400 text-xs font-serif text-right">{shareError}</p>
                )}
              </div>
            )}

            {/* Share Link Display - Show after link is generated */}
            {shareLink && (
              <div className="bg-black/80 backdrop-blur-md border-2 border-[#D4AF37] p-4 max-w-sm">
                <p className="text-[#F5E6BF] font-serif text-sm mb-2">分享链接已生成</p>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={shareLink}
                    readOnly
                    className="flex-1 bg-black/50 text-[#D4AF37] px-3 py-2 text-xs border border-[#D4AF37]/30 font-mono"
                  />
                  <button
                    onClick={handleCopyLink}
                    className="px-3 py-2 border border-[#D4AF37] bg-[#D4AF37]/10 hover:bg-[#D4AF37]/20 transition-colors shrink-0"
                  >
                    <span className="text-[#D4AF37] text-xs font-serif whitespace-nowrap">
                      {copied ? '✓ 已复制' : '复制'}
                    </span>
                  </button>
                </div>
                <p className="text-[#F5E6BF]/50 text-xs font-serif">
                  30天后过期
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Decorative Corners */}
      <div className="absolute top-8 left-8 w-16 h-16 border-t-2 border-l-2 border-[#D4AF37] opacity-50"></div>
      <div className="absolute top-8 right-8 w-16 h-16 border-t-2 border-r-2 border-[#D4AF37] opacity-50"></div>
      <div className="absolute bottom-8 left-8 w-16 h-16 border-b-2 border-l-2 border-[#D4AF37] opacity-50"></div>
      <div className="absolute bottom-8 right-8 w-16 h-16 border-b-2 border-r-2 border-[#D4AF37] opacity-50"></div>
    </div>
  );
};