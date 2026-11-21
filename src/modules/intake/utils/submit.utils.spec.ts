import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { checkedFilesOf, limitReporter, mailTracking } from "./submit.utils";

const keyId = new ObjectId();
const key = { _id: keyId, attachmentsEnabled: true };

function counting() {
  const refused: { id: ObjectId; error: unknown }[] = [];
  return {
    refused,
    intake: {
      countRefusal: (id: ObjectId, error: unknown) => {
        refused.push({ id, error });
      },
    },
  };
}

describe("checkedFilesOf", () => {
  test("no declared file gives none, and counts nothing", () => {
    const { intake, refused } = counting();
    expect(checkedFilesOf(intake, key, undefined)).toEqual([]);
    expect(checkedFilesOf(intake, key, [])).toEqual([]);
    expect(refused).toHaveLength(0);
  });

  test("a file on a key with attachments off is refused and counted on the key", () => {
    const { intake, refused } = counting();
    const declared = [{ kind: "screenshot", type: "image/png", size: 10 }];
    expect(() =>
      checkedFilesOf(
        intake,
        { ...key, attachmentsEnabled: false },
        declared as never,
      ),
    ).toThrow();
    expect(refused).toHaveLength(1);
    expect(refused[0]?.id).toBe(keyId);
  });
});

describe("limitReporter", () => {
  const organisationId = new ObjectId();
  function limits() {
    const picked: unknown[] = [];
    const intake = {
      limit: async (pick: (l: never) => unknown, params: unknown) => {
        picked.push({
          name: pick({
            intakeEmail: "email",
            intakeOrganisation: "organisation",
          } as never),
          params,
        });
      },
    };
    return { picked, intake: intake as never };
  }

  test("an e-mail spends its digest, then the organisation", async () => {
    const { picked, intake } = limits();
    await limitReporter(intake, { organisationId }, "a@x.io");
    expect(picked).toHaveLength(2);
    expect((picked[0] as { name: string }).name).toBe("email");
    expect((picked[1] as { name: string }).name).toBe("organisation");
    expect((picked[1] as { params: unknown }).params).toEqual({
      organisationId: organisationId.toHexString(),
    });
  });

  test("no e-mail spends the organisation alone", async () => {
    const { picked, intake } = limits();
    await limitReporter(intake, { organisationId }, null);
    expect(picked).toHaveLength(1);
    expect((picked[0] as { name: string }).name).toBe("organisation");
  });
});

describe("mailTracking", () => {
  test("sends the tracking link to the reporter in the background", async () => {
    const sent: { from: unknown; to: unknown; text: string }[] = [];
    const works: (() => Promise<void>)[] = [];
    const intake = {
      background: (work: () => Promise<void>) => {
        works.push(work);
      },
      deps: {
        from: "noreply@x.io",
        uiOrigin: "https://ui.x.io",
        mailer: {
          send: async (mail: { from: unknown; to: unknown; text: string }) => {
            sent.push(mail);
          },
        },
      },
    };
    mailTracking(intake as never, { locale: "en" }, "a@x.io", "tok", "Acme");
    expect(sent).toHaveLength(0);
    expect(works).toHaveLength(1);
    await works[0]?.();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.from).toBe("noreply@x.io");
    expect(sent[0]?.to).toEqual({ name: "a@x.io", address: "a@x.io" });
    expect(sent[0]?.text).toContain("https://ui.x.io/track/tok");
  });
});
