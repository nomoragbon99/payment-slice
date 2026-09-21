import { NextResponse } from "next/server";
import type { ZodError } from "zod";

// The one JSON body shape every success response uses.
export function json<T>(status: number, body: T): NextResponse<T> {
  return NextResponse.json(body, { status });
}

// The one error body shape: { error: { code, message, fields? } }.
export function errorResponse(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string[]>,
) {
  return NextResponse.json({ error: { code, message, ...(fields ? { fields } : {}) } }, { status });
}

// Maps a ZodError's issues into { [fieldPath]: message[] } for the error shape's `fields`.
export function validationError(error: ZodError) {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "_root";
    (fields[path] ??= []).push(issue.message);
  }
  return errorResponse(400, "VALIDATION_ERROR", "One or more fields are invalid.", fields);
}
