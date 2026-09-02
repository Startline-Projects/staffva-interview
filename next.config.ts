import type { NextConfig } from "next";

// Baseline security headers. Deliberately excludes Content-Security-Policy:
// a useful CSP needs per-request nonces, and a half-configured one either
// breaks the app or provides false comfort. Worth doing as its own change.
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Interview tokens travel in the URL, so never send this app's full URLs to
  // a third-party origin.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // The live interview records audio via getUserMedia({ audio: true }) and,
  // since the camera proctor (ProctorGate), video via getUserMedia({ video })
  // — BOTH must stay allowed for this origin or the product cannot work.
  // camera=() here made the proctor gate's camera request fail instantly
  // with no permission prompt at all.
  {
    key: "Permissions-Policy",
    value: "microphone=(self), camera=(self), geolocation=(), payment=(), usb=()",
  },
];

const nextConfig: NextConfig = {
  // Strict Mode double-invokes renders and effects in development, which is
  // what surfaces the imperative-resource bugs this app is prone to (the
  // getUserMedia stream, AudioContext and MediaRecorder are all managed through
  // refs). It was disabled, hiding exactly the class of bug worth catching.
  reactStrictMode: true,

  // NOTE: `typescript.ignoreBuildErrors` was removed. It was suppressing real
  // type errors in production builds — including a genuine Blob/Buffer
  // mismatch in the Deepgram client. The build now fails on type errors, which
  // is the point of having them.
  //
  // The `eslint` key was also removed: it is not a valid Next.js 16 option
  // (next lint was removed in 16) and every build logged a warning about it.

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
