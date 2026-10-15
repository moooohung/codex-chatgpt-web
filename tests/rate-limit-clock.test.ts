import { expect, test } from "bun:test";
import {
  adapterFailureFromMessage,
  classifyError,
  inferHttpStatusFromAdapterMessage,
  parseRetryAfterFromMessage,
  parseRetryAtFromMessage,
} from "../src/lib/errors";

const savedNotice = "We're doing a quick check to keep ChatGPT reliable. Try again after 8:27 PM.";
const local = (hour: number, minute = 0, second = 0, day = 10, millisecond = 0) =>
  new Date(2026, 9, day, hour, minute, second, millisecond).getTime();

test("the exact saved after 8:27 PM notice uses host-local time, not the fallback", () => {
  const now = local(20, 0);
  expect(parseRetryAtFromMessage(savedNotice, now)).toBe(local(20, 27));
  expect(parseRetryAfterFromMessage(savedNotice, now)).toBe(27 * 60);
  expect(parseRetryAtFromMessage(savedNotice.replace("after 8:27 PM", "after8:27PM"), now)).toBe(local(20, 27));
});

test.each([
  ["Try again at 12:00 AM.", 23, 50, 0, 0, 11],
  ["Try again after 12:00 PM.", 11, 50, 12, 0, 10],
  ["Try again at 1:05 AM.", 0, 30, 1, 5, 10],
  ["Try again after 1:05 PM.", 12, 30, 13, 5, 10],
  ["Try again at 8:27 PM.", 21, 0, 20, 27, 11],
  ["Retry at 8:27 p.m.", 20, 0, 20, 27, 10],
  ["Try again after 20:27.", 20, 0, 20, 27, 10],
  ["Try again at 8 PM.", 19, 0, 20, 0, 10],
  ["Try again after 8:27\u202fPM.", 20, 0, 20, 27, 10],
  ["Try again after 오후 8:27.", 20, 0, 20, 27, 10],
  ["오후 8:27 이후에 다시 시도해 주세요.", 20, 0, 20, 27, 10],
  ["오전 12시 5분 이후에 다시 시도해 주세요.", 23, 50, 0, 5, 11],
  ["請於下午８：２７後再試一次。", 20, 0, 20, 27, 10],
  ["请在上午12:05后再试。", 23, 50, 0, 5, 11],
  ["午後8時27分以降にもう一度お試しください。", 20, 0, 20, 27, 10],
])("AM/PM, localized clocks and midnight rollover: %s", (message, hour, minute, targetHour, targetMinute, day) => {
  const now = local(hour, minute), target = local(targetHour, targetMinute, 0, day);
  expect(parseRetryAtFromMessage(message, now)).toBe(target);
  expect(parseRetryAfterFromMessage(message, now)).toBe((target - now) / 1_000);
});

test("clock boundaries keep the exact reset instant and ceil fractional remaining seconds", () => {
  expect(parseRetryAtFromMessage(savedNotice, local(20, 27))).toBe(local(20, 27));
  expect(parseRetryAfterFromMessage(savedNotice, local(20, 27))).toBe(0);
  const now = local(20, 26, 59, 10, 500);
  expect(parseRetryAtFromMessage(savedNotice, now)).toBe(local(20, 27));
  expect(parseRetryAfterFromMessage(savedNotice, now)).toBe(1);
  expect(parseRetryAtFromMessage(savedNotice, local(20, 27, 1))).toBe(local(20, 27, 1));
});

test("midnight rollover advances the local calendar across month and year boundaries", () => {
  for (const [now, expected] of [
    [new Date(2026, 9, 31, 23, 59), new Date(2026, 10, 1, 0, 5)],
    [new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 0, 5)],
  ]) expect(parseRetryAtFromMessage("Try again at 12:05 AM", now.getTime())).toBe(expected.getTime());
});

test.each([
  ["Please try again in 2.1s.", 3],
  ["Try again in 3 sec", 3],
  ["Retry after 0.1 seconds.", 1],
  ["Retry-After: 7", 7],
  ["retry after 7", 7],
  ["Retry-After: 2.5", 2],
  ["Try again in 1.5 minutes.", 90],
  ["Retry after 2 hours.", 7_200],
  ["Try again after 2 mins.", 120],
  ["Try again in 1 hour 30 minutes and 0.5 seconds.", 5_401],
  ["Try again in 1h, 2m, 3s.", 3_723],
  ["Try again in 1 day.", 86_400],
])("duration and legacy seconds compatibility: %s", (message, seconds) => {
  const now = local(19);
  expect(parseRetryAfterFromMessage(message, now)).toBe(seconds);
  expect(parseRetryAtFromMessage(message, now)).toBe(now + seconds * 1_000);
});

test.each([
  "Try again later.", "Try again at 0:27 PM.", "Try again at 13:27 PM.",
  "Try again after 8:60 PM.", "Retry after 25:15.", "Retry after 8:270 PM.",
  "Try again in 0 seconds.", "Try again in -2 seconds.",
  "오후 13:27 이후에 다시 시도해 주세요.", "上午13:27後再試。",
  "Meeting at 8:27 PM.", "The user wrote 8:27 PM.", "Security check at 8:27 PM.",
])("only missing or invalid retry times use the 20-minute fallback: %s", message => {
  const now = local(19);
  expect(parseRetryAfterFromMessage(message, now)).toBeUndefined();
  expect(parseRetryAtFromMessage(message, now)).toBe(now + 20 * 60 * 1_000);
});

test("a valid explicit time shorter or longer than 20 minutes never uses the fallback", () => {
  for (const [now, delay] of [[local(20, 26), 60], [local(19), 87 * 60]]) {
    expect(parseRetryAfterFromMessage(savedNotice, now)).toBe(delay);
    expect(parseRetryAtFromMessage(savedNotice, now)).toBe(local(20, 27));
  }
});

test("a clock already in its displayed reset minute expires instead of rolling forward a day", () => {
  for (const offset of [1, 30_000, 59_999]) {
    const now = local(20, 27) + offset;
    expect(parseRetryAtFromMessage(savedNotice, now)).toBe(now);
    expect(parseRetryAfterFromMessage(savedNotice, now)).toBe(0);
  }
});

test("an explicit clock stays authoritative when a delay has also been appended", () => {
  const message = `${savedNotice} Please try again in 1200s.`, now = local(20);
  expect(parseRetryAfterFromMessage(message, now)).toBe(27 * 60);
  expect(parseRetryAtFromMessage(message, now)).toBe(local(20, 27));
});

test("adapter normalization preserves the notice and absolute cooldown metadata", () => {
  const now = local(20, 0);
  expect(adapterFailureFromMessage(savedNotice, now)).toEqual({
    httpStatus: 429,
    error: { message: savedNotice, type: "rate_limit_error", code: "rate_limit_exceeded",
      retryAt: local(20, 27), retryAfterSeconds: 27 * 60 },
  });
  const hourly = "You've reached your hourly limit. Try again later.";
  expect(adapterFailureFromMessage(hourly, now).error).toEqual({
    message: hourly, type: "rate_limit_error", code: "rate_limit_exceeded",
    retryAt: now + 1_200_000, retryAfterSeconds: 1_200,
  });
  expect(adapterFailureFromMessage("Too many requests. Retry after 2.1 seconds.", now)).toMatchObject({
    httpStatus: 429, error: { message: "Too many requests. Retry after 2.1 seconds. Please try again in 3s.",
      retryAfterSeconds: 3, retryAt: now + 3_000 },
  });
  const legacyDialog = "ChatGPT rate limit: too many requests. Try again in a few minutes.";
  expect(adapterFailureFromMessage(legacyDialog, now).error.message).toBe(legacyDialog);
});

test.each([
  "ChatGPT is at capacity. Try again later.", "Security check. Try again after 8:27 PM.",
  "Complete a CAPTCHA to continue.", "We're doing a quick check to verify you are human. Try again later.",
  `The user quoted: ${savedNotice}`,
])("unrelated text is not classified as an account cooldown: %s", message => {
  expect(inferHttpStatusFromAdapterMessage(message)).not.toBe(429);
  expect(classifyError(502, "server_error", message).code).not.toBe("rate_limit_exceeded");
  expect(adapterFailureFromMessage(message, local(20)).error.retryAt).toBeUndefined();
});
