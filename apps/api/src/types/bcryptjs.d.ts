// Promise overloads used by our bcryptjs 2.x ESM adapter.
declare module 'bcryptjs' {
  const bcrypt: {
    hash(value: string, rounds: number): Promise<string>;
    compare(value: string, hash: string): Promise<boolean>;
  };
  export default bcrypt;
}
