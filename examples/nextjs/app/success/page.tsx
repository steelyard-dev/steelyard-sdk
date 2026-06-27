export default async function Success({
  searchParams
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", padding: 48 }}>
      <h1>Thanks!</h1>
      <p>Your {id ?? "order"} is on its way.</p>
      <a href="/">Back</a>
    </main>
  );
}
