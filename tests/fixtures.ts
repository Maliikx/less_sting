/** Small FunPay pages in the REAL layout (see tests/fixtures/real for full saved pages). Content is made up for cleaning tests. */

export const EN_OFFER = `<html><head><title>Fortnite account | FunPay</title></head><body>
<div class="back-link"><a href="https://funpay.com/en/lots/1/" class="js-back-link"><i class="fa fa-chevron-left"></i><span class="inside">Fortnite Accounts</span></a></div>
<div class="page-header page-header-no-hr page-header-params"><h1>Ordering</h1></div>
<div class="param-list"><div class="row">
<div class="col-xs-6"><div class="param-item"><h5>Platform</h5><div class="text-bold">PC</div></div></div>
<div class="col-xs-6"><div class="param-item"><h5>Account level</h5><div class="text-bold">150</div></div></div>
<div class="col-xs-6"><div class="param-item"><h5>In&nbsp;stock</h5><div class="text-bold">1 pcs.</div></div></div></div>
<div class="param-item"><h5>Short description</h5><div>🔥Fortnite Account | Instant Delivery | 200 skins | Warranty</div></div>
<div class="param-item"><h5>Detailed description</h5><div>Full access, instant delivery, 200 skins.<br />Write me in Telegram @seller123 for discounts!<br />I give a 100% guarantee. Check my reviews on FunPay.<br />Email can be changed.</div></div>
<div class="param-item"><h5>Images</h5><div><ul class="attachments-list">
<li class="attachments-item"><a class="attachments-thumb" style="background-image: url(https://sfunpay.com/s/offer/ab/cd/abcd1_thumb.jpg);" href="https://sfunpay.com/s/offer/ab/cd/abcd1.jpg"></a></li>
<li class="attachments-item"><a class="attachments-thumb" style="background-image: url(https://sfunpay.com/s/offer/ab/cd/abcd2_thumb.jpg);" href="https://sfunpay.com/s/offer/ab/cd/abcd2.jpg"></a></li>
</ul></div></div>
<div class="chat-float-container"></div>
<form><select class="form-control" name="method">
<option value="0" class="hidden" data-content="&lt;span class=&quot;payment-value&quot;&gt;from 12.50 $&lt;/span&gt;">&nbsp;</option>
<option value="35" data-cy="usd" data-unit="$" data-factors="11.625,1.0752688172043,1" data-content="&lt;span class=&quot;payment&quot;&gt;&lt;span class=&quot;payment-title&quot;&gt;Bank card&lt;/span&gt;&lt;span class=&quot;payment-value&quot;&gt;12.50 $&lt;/span&gt;&lt;/span&gt;">Bank card</option>
<option value="34" data-cy="eur" data-unit="€" data-factors="10.5,1.0752688172043,1" data-content="&lt;span class=&quot;payment&quot;&gt;&lt;span class=&quot;payment-title&quot;&gt;Bank card&lt;/span&gt;&lt;span class=&quot;payment-value&quot;&gt;11.55 €&lt;/span&gt;&lt;/span&gt;">Bank card</option>
</select>
<div class="js-order-prices"><div class="param-item"><h5>Remaining price</h5><div class="text-bold">0</div></div></div></form>
</body></html>`

/** Russian layout (/ru/ page) of a Russian-written offer. Note: real /en/ pages already show FunPay's translation. */
export const RU_OFFER = `<html><body>
<div class="back-link"><a href="https://funpay.com/lots/1/" class="js-back-link"><span class="inside">Аккаунты Fortnite</span></a></div>
<div class="param-list"><div class="row">
<div class="col-xs-6"><div class="param-item"><h5>Платформа</h5><div class="text-bold">PC</div></div></div>
<div class="col-xs-6"><div class="param-item"><h5>Наличие</h5><div class="text-bold">1 шт.</div></div></div></div>
<div class="param-item"><h5>Краткое описание</h5><div>Аккаунт Fortnite | Мгновенная выдача | Гарантия | 150 скинов</div></div>
<div class="param-item"><h5>Подробное описание</h5><div>Личный аккаунт. Уровень 150, платформа PC. Пишите в телеграм. Спасибо за покупку!</div></div>
<div class="param-item"><h5>Картинки</h5><div><ul class="attachments-list">
<li class="attachments-item"><a class="attachments-thumb" style="background-image: url(https://sfunpay.com/s/offer/aa/bb/t.jpg);" href="https://sfunpay.com/s/offer/aa/bb/aabb1.jpg"></a></li>
</ul></div></div>
<form><select name="method">
<option value="42" data-cy="rub" data-unit="₽" data-factors="900,1.0752688172043,1" data-content="&lt;span class=&quot;payment&quot;&gt;&lt;span class=&quot;payment-title&quot;&gt;Банковская карта&lt;/span&gt;&lt;span class=&quot;payment-value&quot;&gt;957.45 ₽&lt;/span&gt;&lt;/span&gt;">Банковская карта</option>
</select></form>
</body></html>`

/** Real dead page (HTTP 404), trimmed. */
export const DEAD_OFFER = `<html><body><section id="content-body"><div class="page-content-full"><h1 class="page-header">Offer not found</h1>
<div class="content-with-cd"><p class="lead">The offer has expired, been deleted, or never existed in the first place.</p></div></div></section></body></html>`
export const BLOCKED_PAGE = `<html><body>Just a moment... captcha</body></html>`
