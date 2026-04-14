export type DocumentKind = 'board' | 'doc';

export function inferDocumentKind(content: Record<string, unknown> | null | undefined): DocumentKind {
  const kind = content && typeof content['kind'] === 'string' ? (content['kind'] as string) : null;
  if (kind === 'board' || kind === 'doc') return kind;

  if (content && typeof content['items'] === 'object' && content['items'] !== null) {
    return 'board';
  }

  return 'doc';
}

export function createInitialDocumentContent(kind: DocumentKind, title: string): Record<string, unknown> {
  if (kind === 'board') {
    return {
      kind: 'board',
      title,
      description: '',
      items: {},
    };
  }

  return {
    kind: 'doc',
    title,
    body: '',
    comments: {},
    tasks: {},
  };
}

export function documentKindLabel(kind: DocumentKind) {
  return kind === 'board' ? 'Board' : 'Doc';
}
