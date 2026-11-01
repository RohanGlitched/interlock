// The resolution a person would most likely choose for a status or transition: one with the same name
// ("Declined" for Declined), a close cousin for rejections and cancellations, otherwise Done.
export function resolutionFor(values, ...names) {
  const by = (n) => values.find((v) => v.name.toLowerCase() === n.toLowerCase());
  for (const n of names.filter(Boolean)) if (by(n)) return by(n);
  const text = names.join(' ').toLowerCase();
  if (/declin|reject|refus|denied/.test(text)) return by('Declined') || by("Won't Do") || by('Rejected') || by('Done') || values[0];
  if (/cancel|withdraw|abandon/.test(text)) return by('Cancelled') || by('Canceled') || by("Won't Do") || by('Done') || values[0];
  if (/duplicat/.test(text)) return by('Duplicate') || by('Done') || values[0];
  return by('Done') || values[0];
}
