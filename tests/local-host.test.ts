import { expect, test } from "bun:test";
import { isLocalBridgeHost } from "../src/local-host";

test("Host allowlist rejects DNS rebinding, forwarded authority, ambiguity and wrong ports", () => {
  for (const host of ["127.0.0.1", "127.0.0.1:17841", "localhost", "LOCALHOST:17841", "[::1]:17841"]) expect(isLocalBridgeHost(host, 17841)).toBeTrue();
  for (const host of [null, "evil.example", "localhost.evil", "127.0.0.1.evil:17841", "localhost:80", "localhost,evil", "localhost@evil", " localhost", "localhost."]) expect(isLocalBridgeHost(host, 17841)).toBeFalse();
});
