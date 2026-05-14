interface Props { onLogout: () => void }

export default function Overview({ onLogout }: Props) {
  return (
    <div style={{ padding: 24 }}>
      <button onClick={onLogout}>Log out</button>
    </div>
  );
}
