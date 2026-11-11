export const DEFAULT_CONFIG = {
  enabled: true,
  ageRule: { enabled: true, maxAgeDays: 1095, minAgeHours: 0 },
  viewRule: { enabled: true, minViews: 5000, graceHours: 48 },
  watchedRule: { enabled: true },
  blocklistRule: { enabled: true, sendNativeFeedback: false },
  // Feedback that YouTube stores in the Google account. Off unless the user
  // opts in, and then capped per week.
  feedback: { enabled: false, weeklyLimit: 3 },
  titleRule: { enabled: true, patterns: [] },
  updateCheck: { enabled: true },
  subsSync: { enabled: false },
};
