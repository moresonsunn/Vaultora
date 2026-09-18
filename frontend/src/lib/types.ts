/* Shared backend shapes (mirror src/routes/* JSON). */

export interface User {
  id: string;
  username: string;
  role: 'admin' | 'user';
  quota_bytes: number | null;
  totp_enabled: boolean;
  disabled?: boolean;
  created_at: string;
  updated_at?: string;
}

export interface SessionInfo {
  id: string;
  created_at: string;
  expires_at: string;
  ip: string;
  user_agent?: string;
  current?: boolean;
  username?: string;
  user_id?: string;
}

export interface FileItem {
  name: string;
  is_dir: boolean;
  size: number;
  mtime: string;
  kind: string;
  mime: string | null;
  vpath: string;
  starred?: boolean;
}

export interface TrashItem {
  name: string;
  trash_id: string;
  is_dir: boolean;
  size: number;
  mtime: string;
  origin: string | null;
  deleted_at: string;
}

export interface SearchItem {
  vpath: string;
  name: string;
  is_dir: boolean;
  size: number;
  mtime: string;
  kind: string;
}

export interface ShareInfo {
  id: string;
  token: string;
  url: string;
  vpath: string;
  is_dir: boolean;
  has_password: boolean;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  disabled: boolean;
  allow_upload: boolean;
  created_at: string;
  owner?: string;
}

export interface StorageRoot {
  id: string;
  name: string;
  rel_path: string;
  created_at: string;
  users?: { user_id: string; username: string; permission: string }[];
}

export interface AuditItem {
  id: number;
  at: string;
  user_id: string | null;
  username: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
}

export interface VersionInfo {
  id: string;
  size: number;
  mtime: string;
}

export interface ActivityItem {
  at: string;
  action: string;
  detail: string | null;
}

export interface UploadStatus {
  id: string;
  filename: string;
  vdir: string;
  total_size: number;
  received: number;
  status: string;
}

export type SortKey = 'name' | 'size' | 'date' | 'type';
export type SortOrder = 'asc' | 'desc';
export type ViewKind =
  | 'home'
  | 'files'
  | 'shared'
  | 'recent'
  | 'starred'
  | 'trash'
  | 'search'
  | 'activity'
  | 'admin';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
