export function normalizeMetadata(value) {
  return {
    title: value.title.trim(),
    address: value.address.trim(),
    neighborhood: value.neighborhood.trim(),
    latitude: Number(value.latitude),
    longitude: Number(value.longitude),
    description: value.description.trim(),
    image: value.image.trim(),
    kind: value.kind,
    amenities: value.amenities.map((item) => item.trim()),
  };
}
