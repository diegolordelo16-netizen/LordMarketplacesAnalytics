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
export const legacyStockOption=z.object({editVariationId:z.string().regex(/^\d{1,20}$/),beforePriceCents:z.number().int().positive(),beforeStock:z.number().int().nonnegative()}).strict();
export type LegacyStockOption=z.infer<typeof legacyStockOption>;

const upId=z.string().regex(/^MLBU\d{4,17}$/);
export const upOfferOption=z.object({
  userProductId:upId,categoryId:z.string().regex(/^MLB\d{3,12}$/),
  listingTypeId:z.enum(['gold_special','gold_pro']),beforePriceCents:z.number().int().positive(),
  beforeStock:z.number().int().nonnegative(),
}).strict();
type UpOfferOption=z.infer<typeof upOfferOption>;
const upItemSchema=z.object({
  id:itemId,seller_id:remoteId,site_id:z.literal('MLB'),currency_id:z.literal('BRL'),
  user_product_id:upId,category_id:z.string(),listing_type_id:z.string(),buying_mode:z.literal('buy_it_now'),
  condition:z.literal('new'),catalog_listing:z.literal(false),price:z.number().positive(),
  available_quantity:z.number().int().nonnegative(),status:z.string(),
  variations:z.array(z.unknown()).max(0),channels:z.array(z.string()).optional(),
});
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

  async readUpOfferOwner(rawItemId:string,localHandle:string,option:UpOfferOption) {
    const id=itemId.parse(rawItemId.replace(/^MLB-/i,'MLB').toUpperCase());
    const seller=identitySchema.parse(await this.request('/users/me'));
    if(seller.nickname.trim().toLowerCase()!==localHandle.trim().toLowerCase()||!seller.tags.includes('user_product_seller'))throw Error('conta User Products não confirmada');
    const item=upItemSchema.parse(await this.request('/items/'+id));
    const product=z.object({id:upId,user_id:remoteId,site_id:z.literal('MLB')}).parse(await this.request('/user-products/'+option.userProductId));
    if(item.id!==id||item.seller_id!==seller.id||item.user_product_id!==option.userProductId||item.category_id!==option.categoryId||
       product.id!==option.userProductId||product.user_id!==seller.id)throw Error('User Product ou anúncio de outra conta/categoria');
    return {item,sellerId:seller.id};
  }
  async checkUpOffer(item:z.infer<typeof upItemSchema>,sellerId:string,option:UpOfferOption,stock:number) {
    if(item.status!=='active'||item.listing_type_id===option.listingTypeId||Math.round(item.price*100)!==option.beforePriceCents||
       item.available_quantity!==option.beforeStock||stock!==option.beforeStock||!item.channels?.includes('marketplace'))throw Error('condição de venda nova, preço de origem e estoque compartilhado confirmado necessários');
    const response=z.object({seller_id:remoteId,results:z.array(itemId).max(50),paging:z.object({offset:z.literal(0),total:z.number().int().nonnegative()})})
      .parse(await this.request('/users/'+sellerId+'/items/search?user_product_id='+option.userProductId+'&limit=50'));
    if(response.seller_id!==sellerId||response.paging.total!==response.results.length||new Set(response.results).size!==response.results.length||!response.results.includes(item.id))throw Error('lista de ofertas incompleta ou de outra conta');
    for(const id of response.results){
      if(id===item.id)continue;
      const offer=upItemSchema.parse(await this.request('/items/'+id));
      if(offer.id!==id||offer.seller_id!==sellerId||offer.user_product_id!==option.userProductId||
         offer.category_id!==option.categoryId||offer.listing_type_id===option.listingTypeId)throw Error('oferta existente ou contexto de oferta divergente');
    }
    return response.results;
  }
  async createUpOffer(option:UpOfferOption,priceCents:number) {
    const data=await this.request('/user-products/'+option.userProductId+'/items',{
      price:priceCents/100,category_id:option.categoryId,currency_id:'BRL',buying_mode:'buy_it_now',
      listing_type_id:option.listingTypeId,channels:['marketplace'],catalog_listing:false,
    });
    return z.object({id:itemId}).parse(data).id;
  }
  async matchesUpOffer(newId:string,sourceId:string,sellerId:string,option:UpOfferOption,priceCents:number,stock:number) {
    const id=itemId.parse(newId);
    if(id===sourceId)return false;
    const offer=upItemSchema.parse(await this.request('/items/'+id));
    return offer.id===id&&offer.seller_id===sellerId&&offer.user_product_id===option.userProductId&&
      offer.category_id===option.categoryId&&offer.listing_type_id===option.listingTypeId&&
      Math.round(offer.price*100)===priceCents&&offer.available_quantity===stock&&
      ['active','paused'].includes(offer.status)&&offer.channels?.includes('marketplace')===true;
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

  checkStockEdit(item:z.infer<typeof itemSchema>, option:LegacyStockOption, priceCents:number, stock:number) {
    const variant=item.variations.find(row=>row.id===option.editVariationId);
    if(!variant||new Set(item.variations.map(row=>row.id)).size!==item.variations.length||
      variant.price===undefined||Math.round(variant.price*100)!==option.beforePriceCents||
      variant.available_quantity!==option.beforeStock||priceCents!==option.beforePriceCents||stock===option.beforeStock){
      throw Error('estoque anterior, preço inalterado e ID único da variação devem corresponder à proposta');
    }
  }

  async editStock(item:z.infer<typeof itemSchema>, option:LegacyStockOption, stock:number) {
    await this.request('/items/'+item.id,{variations:item.variations.map(row=>row.id===option.editVariationId
      ?{id:row.id,available_quantity:stock}:{id:row.id})},'PUT');
  }

  async matchesStock(item:z.infer<typeof itemSchema>, variation:string, priceCents:number, stock:number) {
    const id=remoteId.parse(variation);
    const rows=item.variations.filter(row=>row.id===id);
    const row=rows[0];
    if(rows.length!==1||!row||row.price===undefined||Math.round(row.price*100)!==priceCents||row.available_quantity!==stock)return false;
    const observed=z.object({id:remoteId,price:z.number().positive(),available_quantity:z.number().int().nonnegative()})
      .parse(await this.request('/items/'+item.id+'/variations/'+id));
    return observed.id===id&&Math.round(observed.price*100)===priceCents&&observed.available_quantity===stock;
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
