// Copyright (c) Steelyard contributors. MIT License.

export type Clock = () => Date;

export function systemClock(): Date {
  return new Date(Date());
}

export function defaultClock(clock?: Clock): Clock {
  return clock ?? systemClock;
}
