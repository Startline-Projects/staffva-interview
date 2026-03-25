import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = createSupabaseServiceClient();

    // Try to query the candidates table (exists in shared StaffVA database)
    const { data, error } = await supabase
      .from("candidates")
      .select("id")
      .limit(1);

    if (error) {
      return NextResponse.json(
        { status: "error", message: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      status: "connected",
      message: "Supabase connection verified",
      candidatesFound: data.length > 0,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { status: "error", message },
      { status: 500 }
    );
  }
}
