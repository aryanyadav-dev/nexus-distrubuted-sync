import { z } from 'zod';

// ─────────────────────────────────────────────
// Core domain types
// ─────────────────────────────────────────────

export const UserRole = z.enum(['owner', 'editor', 'viewer']);
export type UserRole = z.infer<typeof UserRole>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  ownerId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceMemberSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  role: UserRole,
  joinedAt: z.string().datetime(),
  user: UserSchema.optional(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

// Document content is a generic JSON object
export const DocumentContentSchema = z.record(z.string(), z.unknown());
export type DocumentContent = z.infer<typeof DocumentContentSchema>;

export const DocumentSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string(),
  content: DocumentContentSchema,
  revision: z.number().int().nonnegative(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const SnapshotSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  content: DocumentContentSchema,
  createdAt: z.string().datetime(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

// A patch is a partial update of the document content
export const PatchSchema = z.record(z.string(), z.unknown());
export type Patch = z.infer<typeof PatchSchema>;

export const ConflictMetaSchema = z.object({
  conflictingFields: z.array(z.string()),
  clientValue: z.record(z.string(), z.unknown()),
  serverValue: z.record(z.string(), z.unknown()),
  resolvedValue: z.record(z.string(), z.unknown()),
});
export type ConflictMeta = z.infer<typeof ConflictMetaSchema>;

export const MutationSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  userId: z.string().uuid(),
  revision: z.number().int().nonnegative(),   // resulting revision after apply
  baseRevision: z.number().int().nonnegative(), // revision client was on
  patch: PatchSchema,
  conflictMeta: ConflictMetaSchema.nullable(),
  correlationId: z.string().uuid(),
  appliedAt: z.string().datetime(),
});
export type Mutation = z.infer<typeof MutationSchema>;

export const PresenceSchema = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  documentId: z.string().uuid(),
  lastSeen: z.string().datetime(),
  isActive: z.boolean(),
});
export type Presence = z.infer<typeof PresenceSchema>;

// ─────────────────────────────────────────────
// WebSocket message protocol
// ─────────────────────────────────────────────

// Client → Server messages

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  token: z.string(),
  clientId: z.string().uuid(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const SubscribeMessageSchema = z.object({
  type: z.literal('subscribe'),
  documentId: z.string().uuid(),
});
export type SubscribeMessage = z.infer<typeof SubscribeMessageSchema>;

export const MutationMessageSchema = z.object({
  type: z.literal('mutation'),
  correlationId: z.string().uuid(),
  documentId: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  patch: PatchSchema,
  clientId: z.string().uuid().optional(),
});
export type MutationMessage = z.infer<typeof MutationMessageSchema>;

export const HeartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  ts: z.number(),
});
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;

export const UnsubscribeMessageSchema = z.object({
  type: z.literal('unsubscribe'),
  documentId: z.string().uuid(),
});
export type UnsubscribeMessage = z.infer<typeof UnsubscribeMessageSchema>;

export const TypingMessageSchema = z.object({
  type: z.literal('typing'),
  documentId: z.string().uuid(),
  context: z.string(), // "chat" or "task_UUID"
});
export type TypingMessage = z.infer<typeof TypingMessageSchema>;

// Server → Client messages

export const SnapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  documentId: z.string().uuid(),
  content: DocumentContentSchema,
  revision: z.number().int().nonnegative(),
  requestedBy: z.string().uuid().optional(),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;

export const MutationAckSchema = z.object({
  type: z.literal('mutation_ack'),
  correlationId: z.string().uuid(),
  documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  appliedPatch: PatchSchema,
  conflictMeta: ConflictMetaSchema.nullable(),
});
export type MutationAck = z.infer<typeof MutationAckSchema>;

export const RemoteUpdateSchema = z.object({
  type: z.literal('remote_update'),
  documentId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  patch: PatchSchema,
  userId: z.string().uuid(),
  displayName: z.string(),
  correlationId: z.string().uuid(),
  conflictMeta: ConflictMetaSchema.nullable(),
});
export type RemoteUpdate = z.infer<typeof RemoteUpdateSchema>;

export const PresenceUpdateSchema = z.object({
  type: z.literal('presence_update'),
  documentId: z.string().uuid(),
  presence: z.array(PresenceSchema),
});
export type PresenceUpdate = z.infer<typeof PresenceUpdateSchema>;

export const TypingUpdateSchema = z.object({
  type: z.literal('typing_update'),
  documentId: z.string().uuid(),
  userId: z.string().uuid(),
  displayName: z.string(),
  context: z.string(), // "chat" or "task_UUID"
});
export type TypingUpdate = z.infer<typeof TypingUpdateSchema>;

export const HeartbeatAckSchema = z.object({
  type: z.literal('heartbeat_ack'),
  ts: z.number(),
  serverTs: z.number(),
});
export type HeartbeatAck = z.infer<typeof HeartbeatAckSchema>;

export const ConflictMessageSchema = z.object({
  type: z.literal('conflict'),
  documentId: z.string().uuid(),
  correlationId: z.string().uuid(),
  conflictMeta: ConflictMetaSchema,
});
export type ConflictMessage = z.infer<typeof ConflictMessageSchema>;

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  correlationId: z.string().uuid().optional(),
});
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

export const AuthenticatedSchema = z.object({
  type: z.literal('authenticated'),
  userId: z.string().uuid(),
  displayName: z.string(),
});
export type Authenticated = z.infer<typeof AuthenticatedSchema>;

// Union of all inbound (client→server) messages
export const InboundMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SubscribeMessageSchema,
  MutationMessageSchema,
  HeartbeatMessageSchema,
  UnsubscribeMessageSchema,
  TypingMessageSchema,
]);
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

// Union of all outbound (server→client) messages
export type OutboundMessage =
  | SnapshotMessage
  | MutationAck
  | RemoteUpdate
  | PresenceUpdate
  | TypingUpdate
  | HeartbeatAck
  | ConflictMessage
  | ErrorMessage
  | Authenticated;

// ─────────────────────────────────────────────
// REST API request/response schemas
// ─────────────────────────────────────────────

export const SignUpRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(100),
});
export type SignUpRequest = z.infer<typeof SignUpRequestSchema>;

export const SignInRequestSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});
export type SignInRequest = z.infer<typeof SignInRequestSchema>;

export const AuthResponseSchema = z.object({
  token: z.string(),
  user: UserSchema,
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1).max(200),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const InviteMemberRequestSchema = z.object({
  email: z.string().email(),
  role: UserRole.exclude(['owner']),
});
export type InviteMemberRequest = z.infer<typeof InviteMemberRequestSchema>;

export const CreateDocumentRequestSchema = z.object({
  title: z.string().min(1).max(500),
  initialContent: DocumentContentSchema.optional(),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequestSchema>;

// ─────────────────────────────────────────────
// Checklist demo types (concrete content model)
// ─────────────────────────────────────────────

export const ChecklistItemSchema = z.object({
  id: z.string().uuid(),
  text: z.string(),
  completed: z.boolean(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  order: z.number().int().nonnegative(),
  note: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  assigneeId: z.string().uuid().optional(),
  dueDate: z.string().datetime().optional(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistContentSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  items: z.record(z.string(), ChecklistItemSchema), // keyed by item id
});
export type ChecklistContent = z.infer<typeof ChecklistContentSchema>;

// ─────────────────────────────────────────────
// Mutation queue types (deterministic reconciliation)
// ─────────────────────────────────────────────

export const QueuedMutationSchema = z.object({
  correlationId: z.string().uuid(),
  documentId: z.string().uuid(),
  userId: z.string().uuid(),
  clientId: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  patch: PatchSchema,
  receivedAt: z.number(), // server-side monotonic timestamp (Date.now())
});
export type QueuedMutation = z.infer<typeof QueuedMutationSchema>;

// ─────────────────────────────────────────────
// Utility types
// ─────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  ok: true;
}

export interface ApiError {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResult<T> = ApiResponse<T> | ApiError;
