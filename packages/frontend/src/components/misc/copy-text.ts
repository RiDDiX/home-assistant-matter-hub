// navigator.clipboard only exists on secure origins, the add-on is often
// opened over plain http on the LAN.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the copy event
  }
  // A copy listener sets the data itself, so this needs no focus or
  // selection and also works inside a dialog focus trap.
  let copied = false;
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData("text/plain", text);
    copied = !!e.clipboardData;
    e.preventDefault();
  };
  document.addEventListener("copy", onCopy);
  try {
    return document.execCommand("copy") && copied;
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}
