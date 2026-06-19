import { useState, useCallback, useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  FolderIcon,
  FileIcon,
  RefreshCwIcon,
  DownloadIcon,
  EyeIcon,
  XIcon,
  ServerIcon,
  ChevronUpIcon,
  InfoIcon,
} from "lucide-react";

export interface SandboxFile {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

interface SandboxFileBrowserProps {
  sandboxId?: string | null;
  refreshTrigger?: number;
  sessionId?: string | null;
}

export function SandboxFileBrowser({ sandboxId: propSandboxId, refreshTrigger = 0, sessionId }: SandboxFileBrowserProps) {
  // Only use the sandbox assigned to this user's session - don't show other users' sandboxes
  const [selectedSandbox, setSelectedSandbox] = useState<string | null>(propSandboxId ?? null);
  const [files, setFiles] = useState<SandboxFile[]>([]);
  const [currentPath, setCurrentPath] = useState<string>("/home/user");
  const [previewFile, setPreviewFile] = useState<SandboxFile | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewEncoding, setPreviewEncoding] = useState<string>("text");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevFilePathsRef = useRef<Set<string>>(new Set());
  const fetchDebounceRef = useRef<{ key: string; timer: NodeJS.Timeout | null }>({ key: '', timer: null });

  // Clear files when starting a new session (sessionId becomes null)
  useEffect(() => {
    if (sessionId === null) {
      setFiles([]);
    }
  }, [sessionId]);

  const isPreviewableFile = (name: string) => {
    const previewableExtensions = ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'];
    return previewableExtensions.some((ext) => name.toLowerCase().endsWith(ext));
  };

  const debouncedFetchFiles = useCallback(async (sandbox: string, path: string, delay: number = 0) => {
    const fetchKey = `${sandbox}:${path}`;

    // Cancel any pending fetch
    if (fetchDebounceRef.current.timer) {
      clearTimeout(fetchDebounceRef.current.timer);
    }

    // Skip if we just fetched this exact combination
    if (delay === 0 && fetchDebounceRef.current.key === fetchKey) {
      return;
    }

    const doFetch = async () => {
      fetchDebounceRef.current.key = fetchKey;
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/sandboxes/${sandbox}/files?path=${encodeURIComponent(path)}`
        );
        const data = await response.json();
        const newFiles = Array.isArray(data) ? data : [];
        setFiles(newFiles);
        prevFilePathsRef.current = new Set(newFiles.map((f: SandboxFile) => f.path));
      } catch {
        setError("Failed to list files");
      } finally {
        setIsLoading(false);
      }
    };

    if (delay > 0) {
      fetchDebounceRef.current.timer = setTimeout(doFetch, delay);
    } else {
      await doFetch();
    }
  }, []);

  const refreshFiles = useCallback(async () => {
    if (!selectedSandbox) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/sandboxes/${selectedSandbox}/files?path=${encodeURIComponent(currentPath)}`
      );
      const data = await response.json();
      setFiles(Array.isArray(data) ? data : []);
    } catch {
      setError("Failed to list files");
    } finally {
      setIsLoading(false);
    }
  }, [selectedSandbox, currentPath]);

  const handlePreview = useCallback(
    async (file: SandboxFile) => {
      if (!selectedSandbox) return;
      setPreviewFile(file);
      setIsLoading(true);
      setPreviewContent("");
      try {
        const response = await fetch(
          `/api/sandboxes/${selectedSandbox}/files/content?path=${encodeURIComponent(file.path)}`
        );
        const data = await response.json();
        setPreviewContent(data.content || "");
        setPreviewEncoding(data.encoding || "text");
      } catch {
        setPreviewContent("Failed to load file content");
        setPreviewEncoding("text");
      } finally {
        setIsLoading(false);
      }
    },
    [selectedSandbox]
  );

  const handleDownload = useCallback(
    (file: SandboxFile) => {
      if (!selectedSandbox) return;
      // Open download URL in new tab/trigger download
      window.open(
        `/api/sandboxes/${selectedSandbox}/download?path=${encodeURIComponent(file.path)}`,
        "_blank"
      );
    },
    [selectedSandbox]
  );

  const handleNavigate = useCallback((file: SandboxFile) => {
    if (file.type === "directory") {
      setCurrentPath(file.path);
      setPreviewFile(null);
    }
  }, []);

  const handleGoUp = useCallback(() => {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    const newPath = "/" + parts.join("/") || "/";
    // Don't go above /home/user by default
    setCurrentPath(newPath.length < "/home/user".length ? "/home/user" : newPath);
    setPreviewFile(null);
  }, [currentPath]);

  // Update selected sandbox when prop changes
  useEffect(() => {
    if (propSandboxId) {
      setSelectedSandbox(propSandboxId);
      setCurrentPath("/home/user");
      setPreviewFile(null);
    }
  }, [propSandboxId]);

  // Refresh files when sandbox or path changes
  useEffect(() => {
    if (selectedSandbox) {
      debouncedFetchFiles(selectedSandbox, currentPath, 0);
    }
  }, [selectedSandbox, currentPath, debouncedFetchFiles]);

  // Refresh files when session changes (e.g., switching worldlines restores different snapshot)
  useEffect(() => {
    if (selectedSandbox && sessionId) {
      debouncedFetchFiles(selectedSandbox, currentPath, 500);
    }
    return () => {
      if (fetchDebounceRef.current.timer) {
        clearTimeout(fetchDebounceRef.current.timer);
      }
    };
  }, [sessionId, selectedSandbox, currentPath, debouncedFetchFiles]);

  // Refresh files when triggered by parent (e.g., after assistant turn completes)
  // Also auto-preview new previewable files (HTML, images)
  useEffect(() => {
    if (!selectedSandbox || refreshTrigger <= 0) return;

    // Guard against out-of-order responses: if the sandbox/path changes (or the
    // component unmounts) while this fetch is in flight, a late response must not
    // overwrite the current file list with stale data.
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `/api/sandboxes/${selectedSandbox}/files?path=${encodeURIComponent(currentPath)}`
        );
        const newFiles: SandboxFile[] = await response.json();
        if (cancelled || !Array.isArray(newFiles)) return;

        // Find new previewable files (not in previous list)
        const newPreviewableFiles = newFiles.filter(
          (f) =>
            f.type === 'file' &&
            !prevFilePathsRef.current.has(f.path) &&
            isPreviewableFile(f.name)
        );

        // Update state
        setFiles(newFiles);

        // Update ref for next comparison
        prevFilePathsRef.current = new Set(newFiles.map((f) => f.path));

        // Auto-preview the first new previewable file
        if (newPreviewableFiles.length > 0) {
          handlePreview(newPreviewableFiles[0]);
        }
      } catch {
        // File listing is best-effort; ignore transient fetch errors.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshTrigger, selectedSandbox, currentPath, handlePreview]);

  const formatSize = (bytes?: number) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isImageFile = (name: string) => {
    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"];
    return imageExtensions.some((ext) => name.toLowerCase().endsWith(ext));
  };

  const isHtmlFile = (name: string) => {
    return name.toLowerCase().endsWith(".html") || name.toLowerCase().endsWith(".htm");
  };

  const getImageMimeType = (name: string) => {
    const ext = name.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      ico: 'image/x-icon',
      bmp: 'image/bmp',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <ServerIcon className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Sandbox Files</span>
          {selectedSandbox && (
            <div className="relative group">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(selectedSandbox);
                }}
                className="hover:text-foreground transition-colors"
                title="Click to copy sandbox ID"
              >
                <InfoIcon className="h-3.5 w-3.5 text-muted-foreground cursor-pointer" />
              </button>
              <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block bg-popover border rounded-md px-2 py-1 text-xs shadow-md whitespace-nowrap">
                {selectedSandbox} (click to copy)
              </div>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            if (selectedSandbox) refreshFiles();
          }}
          disabled={isLoading || !selectedSandbox}
        >
          <RefreshCwIcon className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Breadcrumb / Path - only show paths beyond /home/user */}
      {selectedSandbox && currentPath !== "/home/user" && (
        <div className="flex items-center gap-1 border-b px-4 py-2 text-xs text-muted-foreground">
          {currentPath
            .replace("/home/user", "")
            .split("/")
            .filter(Boolean)
            .map((part, i, arr) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span>/</span>}
                <button
                  className="hover:text-foreground"
                  onClick={() => {
                    setCurrentPath("/home/user/" + arr.slice(0, i + 1).join("/"));
                    setPreviewFile(null);
                  }}
                >
                  {part}
                </button>
              </span>
            ))}
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* File list - hidden when previewing */}
        {!previewFile && (
        <ScrollArea className="flex-1">
          <div className="p-2">
            {/* Go up button */}
            {currentPath !== "/home/user" && selectedSandbox && (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                onClick={handleGoUp}
              >
                <ChevronUpIcon className="h-4 w-4 text-muted-foreground" />
                <span>..</span>
              </button>
            )}

            {/* Empty states */}
            {files.filter((f) => !f.name.startsWith('.')).length === 0 && !isLoading && selectedSandbox && (
              <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                No files found in this directory
              </div>
            )}
            {!selectedSandbox && !isLoading && (
              <div className="flex flex-col items-center justify-center min-h-[50vh] text-sm text-muted-foreground">
                <ServerIcon className="mb-2 h-8 w-8 opacity-50" />
                <div>No sandbox active</div>
                <div className="text-xs mt-1 opacity-70">Sandbox will be created when you run code</div>
              </div>
            )}

            {/* Loading state - no text to avoid double loading flash */}
            {isLoading && files.length === 0 && (
              <div className="px-2 py-4 flex justify-center">
                <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* File list - filter out dotfiles/hidden files */}
            {files.filter((file) => !file.name.startsWith('.')).map((file) => (
              <div
                key={file.path}
                className="group flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted"
              >
                <button
                  className="flex flex-1 items-center gap-2 text-left overflow-hidden"
                  onClick={() =>
                    file.type === "directory"
                      ? handleNavigate(file)
                      : handlePreview(file)
                  }
                >
                  {file.type === "directory" ? (
                    <FolderIcon className="h-4 w-4 shrink-0 text-blue-500" />
                  ) : (
                    <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{file.name}</span>
                </button>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {file.type === "file" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handlePreview(file);
                        }}
                        title="Preview"
                      >
                        <EyeIcon className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(file);
                        }}
                        title="Download"
                      >
                        <DownloadIcon className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
        )}

        {/* Preview pane - full width */}
        {previewFile && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="truncate text-sm font-medium">
                {previewFile.name}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">
                  {formatSize(previewFile.size)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => handleDownload(previewFile)}
                  title="Download"
                >
                  <DownloadIcon className="h-3 w-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setPreviewFile(null)}
                  title="Close preview"
                >
                  <XIcon className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <ScrollArea className="flex-1">
              <div className="p-4">
                {isLoading ? (
                  <div className="flex justify-center py-4">
                    <RefreshCwIcon className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : previewEncoding === "base64" && isImageFile(previewFile.name) ? (
                  <div className="flex items-center justify-center h-full min-h-[300px]">
                    <img
                      src={`data:${getImageMimeType(previewFile.name)};base64,${previewContent}`}
                      alt={previewFile.name}
                      className="max-w-full max-h-[calc(100vh-200px)] object-contain rounded shadow-sm"
                    />
                  </div>
                ) : isHtmlFile(previewFile.name) ? (
                  <iframe
                    srcDoc={previewContent}
                    title={previewFile.name}
                    className="w-full h-[calc(100vh-180px)] border rounded bg-white"
                    sandbox="allow-scripts allow-same-origin"
                  />
                ) : (
                  <pre className="whitespace-pre-wrap break-all text-xs font-mono bg-muted/50 p-2 rounded">
                    {previewContent || "(empty file)"}
                  </pre>
                )}
              </div>
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
}
