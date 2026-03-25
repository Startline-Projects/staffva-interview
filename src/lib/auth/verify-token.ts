import jwt from "jsonwebtoken";

interface InterviewTokenPayload {
  candidate_id: string;
  iat?: number;
  exp?: number;
}

export function verifyInterviewToken(token: string): InterviewTokenPayload {
  const secret = process.env.JWT_INTERVIEW_SECRET;
  if (!secret) {
    throw new Error("JWT_INTERVIEW_SECRET is not configured");
  }

  const payload = jwt.verify(token, secret) as InterviewTokenPayload;

  if (!payload.candidate_id) {
    throw new Error("Token missing candidate_id");
  }

  return payload;
}

export function generateInterviewToken(candidateId: string): string {
  const secret = process.env.JWT_INTERVIEW_SECRET;
  if (!secret) {
    throw new Error("JWT_INTERVIEW_SECRET is not configured");
  }

  return jwt.sign({ candidate_id: candidateId }, secret, { expiresIn: "24h" });
}
