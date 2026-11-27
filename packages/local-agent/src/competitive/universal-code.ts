import { z } from 'zod';

export function validUniversalCode(code:string):boolean {
  if(!/^(?:\d{8}|\d{12,14})$/.test(code)||/^0+$/.test(code))return false;
  const digits=Array.from(code,Number);
  const check=digits.pop();
  const sum=digits.reverse().reduce((total,digit,index)=>total+digit*(index%2===0?3:1),0);
  return (10-sum%10)%10===check;
}

export const universalCode=z.string().trim().refine(validUniversalCode,'EAN, UPC ou GTIN inválido');
