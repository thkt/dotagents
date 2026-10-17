export function loadProfile(text) {
  const value = JSON.parse(text);
  return { directory: value.last_folder ?? '/documents' };
}
