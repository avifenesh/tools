import { describe, expect, it } from "vitest";
import { read } from "../src/read.js";
import {
  makeSession,
  makeTempDir,
  writeBinaryFixture,
  writeFixture,
} from "./helpers.js";

describe("read — binary + attachments", () => {
  it("refuses a file with NUL bytes as BINARY", async () => {
    const dir = makeTempDir();
    const bytes = new Uint8Array([0x48, 0x00, 0x65, 0x6c, 0x6c, 0x6f]);
    const p = writeBinaryFixture(dir, "n.dat", bytes);
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("BINARY");
  });

  it("refuses by extension even for empty .exe", async () => {
    const dir = makeTempDir();
    const p = writeBinaryFixture(dir, "hello.exe", new Uint8Array([1, 2, 3, 4]));
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.error.code).toBe("BINARY");
  });

  it("returns PDF as attachment", async () => {
    const dir = makeTempDir();
    const p = writeBinaryFixture(
      dir,
      "doc.pdf",
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    );
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("attachment");
    if (r.kind !== "attachment") return;
    expect(r.output).toBe("PDF read successfully");
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]!.mime).toBe("application/pdf");
    expect(r.attachments[0]!.dataUrl).toMatch(/^data:application\/pdf;base64,/);
  });

  it("returns PNG as image attachment", async () => {
    const dir = makeTempDir();
    const p = writeBinaryFixture(
      dir,
      "pic.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("attachment");
    if (r.kind !== "attachment") return;
    expect(r.output).toBe("Image read successfully");
    expect(r.attachments[0]!.mime).toBe("image/png");
  });

  it("treats SVG as text (not an image attachment)", async () => {
    const dir = makeTempDir();
    const p = writeFixture(
      dir,
      "icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    );
    const r = await read({ path: p }, makeSession(dir));
    expect(r.kind).toBe("text");
  });
});
