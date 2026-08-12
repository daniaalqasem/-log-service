interface CursorData {
  ts: string;
  id: number;
}

export function encodeCursor(data: CursorData): string {
  const json = JSON.stringify(data);
  return Buffer.from(json, 'utf-8').toString('base64');
}

export function decodeCursor(cursor: string): CursorData | null {
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);

    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'number') {
      return null;
    }

    return { ts: parsed.ts, id: parsed.id };
  } catch {
    return null;
  }
}
