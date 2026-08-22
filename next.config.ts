import type { NextConfig } from "next";

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
};

export default nextConfig;
