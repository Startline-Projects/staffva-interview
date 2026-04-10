-- Add pre-interview guide columns to ai_interviews
ALTER TABLE ai_interviews
  ADD COLUMN IF NOT EXISTS pre_interview_guide text,
  ADD COLUMN IF NOT EXISTS pre_interview_guide_generated_at timestamptz;
