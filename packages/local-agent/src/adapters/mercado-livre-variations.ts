import { z } from 'zod';

const remoteId = z.union([z.number().int().positive(), z.string().regex(/^\d{1,20}$/)]).transform(String);
const itemId = z.string().regex(/^MLB\d{5,17}$/);
const combination = z.object({
  id: z.string().regex(/^[A-Z0-9_]{1,80}$/),
  value_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
}).strict();
export const legacyVariationOption = z.object({
  attributeCombinations: z.array(combination).min(1).max(20)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'atributos repetidos'),
  pictureIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,120}$/)).min(1).max(30)
    .refine(ids => new Set(ids).size === ids.length, 'imagens repetidas'),
}).strict();
export type LegacyVariationOption = z.infer<typeof legacyVariationOption>;

const identitySchema = z.object({id:remoteId,nickname:z.string().min(1),site_id:z.literal('MLB'),tags:z.array(z.string())});
const itemSchema = z.object({
  id:itemId,seller_id:remoteId,site_id:z.literal('MLB'),currency_id:z.literal('BRL'),
  status:z.literal('active'),user_product_id:z.null().optional(),
  pictures:z.array(z.object({id:z.string()})),
  variations:z.array(z.object({id:remoteId,attribute_combinations:z.array(z.object({id:z.string().nullable(),value_id:z.string().nullable()})),
    price:z.number().positive().optional(),available_quantity:z.number().int().nonnegative().optional(),
    sold_quantity:z.number().int().nonnegative().optional()})).min(1),
});
const variationSchema = z.object({
  id:remoteId,price:z.number().positive(),available_quantity:z.number().int().nonnegative(),
  picture_ids:z.array(z.string()),attribute_combinations:z.array(combination.passthrough()),
});

const ids = (rows: Array<{id:string|null;value_id:string|null}>) =>
  JSON.stringify(rows.map(row=>JSON.stringify([row.id,row.value_id])).sort());

export class MercadoLivreVariations {
  constructor(private readonly token:string) {}

  private async request(path:string, body?:unknown, method=body===undefined?'GET':'POST'):Promise<unknown> {
    const response=await fetch(new URL(path,'https://api.mercadolibre.com'),{
      method,
      headers:{Authorization:'Bearer '+this.token,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      redirect:'error',
      signal:AbortSignal.timeout(10000),
    });
    if(!response.ok)throw Error('API do Mercado Livre respondeu HTTP '+response.status);
    if(method==='DELETE')return null;
    return response.json();
  }

  async readOwner(rawItemId:string, localHandle:string) {
    const id=itemId.parse(rawItemId.replace(/^MLB-/i,'MLB').toUpperCase());
    const seller=identitySchema.parse(await this.request('/users/me'));
    if(seller.nickname.trim().toLowerCase()!==localHandle.trim().toLowerCase())throw Error('token de outra conta do Mercado Livre');
    if(seller.tags.includes('user_product_seller'))throw Error('a loja usa o modelo User Products');
    const item=itemSchema.parse(await this.request('/items/'+id));
    if(item.id!==id||item.seller_id!==seller.id)throw Error('anúncio de outra conta do Mercado Livre');
    return { item, sellerId:seller.id };
  }

  checkNewOption(item:z.infer<typeof itemSchema>, option:LegacyVariationOption) {
    if(option.pictureIds.some(id=>!item.pictures.some(pic=>pic.id===id)))throw Error('imagem fora do anúncio aprovado');
    if(item.variations.some(variant=>ids(variant.attribute_combinations)===ids(option.attributeCombinations))){
      throw Error('a combinação de atributos já existe no anúncio');
    }
  }

  async create(item:string, option:LegacyVariationOption, priceCents:number, stock:number) {
    const data=await this.request('/items/'+itemId.parse(item)+'/variations',{
      attribute_combinations:option.attributeCombinations,price:priceCents/100,
      available_quantity:stock,sold_quantity:0,picture_ids:option.pictureIds,
    });
    return z.object({id:remoteId}).parse(data).id;
  }

  checkRemoval(item:z.infer<typeof itemSchema>, variationId:string, priceCents:number) {
    const variant=item.variations.find(row=>row.id===variationId);
    if(item.variations.length<2||!variant||variant.available_quantity!==0||variant.sold_quantity!==0||
        variant.price===undefined||Math.round(variant.price*100)!==priceCents){
      throw Error('remoção exige outra variação no anúncio e um alvo sem estoque, sem vendas e com preço aprovado');
    }
  }

  async remove(item:string, variation:string) {
    await this.request('/items/'+itemId.parse(item)+'/variations/'+remoteId.parse(variation),undefined,'DELETE');
  }

  async matches(item:string, variation:string, option:LegacyVariationOption, priceCents:number, stock:number) {
    const id=remoteId.parse(variation);
    const observed=variationSchema.parse(await this.request('/items/'+itemId.parse(item)+'/variations/'+id));
    return observed.id===id&&Math.round(observed.price*100)===priceCents&&observed.available_quantity===stock&&
      ids(observed.attribute_combinations)===ids(option.attributeCombinations)&&
      JSON.stringify([...observed.picture_ids].sort())===JSON.stringify([...option.pictureIds].sort());
  }
}
