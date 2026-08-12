'use client';

export default function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      style={{
        fontSize: 13,
        color: '#A32D2D',
        background: '#FBEEEE',
        border: '1px solid #E5C6C6',
        borderRadius: 6,
        padding: '8px 12px',
        marginBottom: 12,
      }}
    >
      {message}
    </p>
  );
}
